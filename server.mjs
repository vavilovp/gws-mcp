#!/usr/bin/env node
/**
 * gws-mcp — a small Google Workspace MCP server (Gmail, Calendar, Drive, Contacts).
 *
 * Zero dependencies: Node 18+ standard library only.
 * Transport: MCP over stdio (JSON-RPC 2.0, one message per line).
 *
 * Modes:
 *   gws-mcp            start the MCP server (stdio)
 *   gws-mcp --auth     run the browser OAuth flow and store the token
 *   gws-mcp --status   show whether credentials and a token are present
 *   gws-mcp --help     show usage
 *
 * Files:
 *   ~/.config/gws-mcp/credentials.json  OAuth client (Desktop app) from Google Cloud
 *   ~/.config/gws-mcp/token.json        refresh/access token, mode 0600
 *
 * Environment:
 *   GWS_MCP_HOME            config directory (default ~/.config/gws-mcp)
 *   GWS_MCP_CREDENTIALS     path to the OAuth client JSON
 *   GWS_MCP_TOKEN           path to the token file
 *   GWS_MCP_PORT            first loopback port to try (default 43117)
 *   GWS_MCP_GROUPS          comma list: gmail,calendar,drive,contacts (default all)
 *   GWS_MCP_DRIVE_SCOPE     "full" (default) or "file" (non-restricted, app files only)
 *   GWS_MCP_ALLOW_SEND      set to 0/false to hide the send_email tool
 *   GWS_MCP_DOWNLOAD_DIR    where downloaded files are written
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const SERVER_NAME = "gws-mcp";
const SERVER_VERSION = "0.4.0";

const CONFIG_DIR = process.env.GWS_MCP_HOME || join(homedir(), ".config", "gws-mcp");
const CREDENTIALS_PATH = process.env.GWS_MCP_CREDENTIALS || join(CONFIG_DIR, "credentials.json");
const TOKEN_PATH = process.env.GWS_MCP_TOKEN || join(CONFIG_DIR, "token.json");
const BASE_PORT = Number(process.env.GWS_MCP_PORT || 43117);

const log = (...args) => console.error(`[${SERVER_NAME}]`, ...args);

const isOff = (value) => ["0", "false", "no", "off"].includes(String(value ?? "").toLowerCase());

// ---------------------------------------------------------------------------
// Scopes and feature groups
// ---------------------------------------------------------------------------

// `drive` is a restricted scope: it is what allows trashing and moving files
// the app did not create. There is no permanent delete or permission change
// anywhere in this code.
// Set GWS_MCP_DRIVE_SCOPE=file to request drive.file instead; that scope is
// not restricted, but then only files this app created or the user opened with
// it are visible.
const DRIVE_SCOPE =
  String(process.env.GWS_MCP_DRIVE_SCOPE ?? "full").toLowerCase() === "file"
    ? "https://www.googleapis.com/auth/drive.file"
    : "https://www.googleapis.com/auth/drive";

const GROUP_SCOPES = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  calendar: [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
  drive: [DRIVE_SCOPE],
  contacts: ["https://www.googleapis.com/auth/contacts.readonly"],
};

function parseGroups(raw) {
  const requested = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const base = requested.length ? requested : Object.keys(GROUP_SCOPES);
  const unknown = base.filter((item) => !(item in GROUP_SCOPES));
  if (unknown.length) log(`Ignoring unknown groups: ${unknown.join(", ")}`);
  return base.filter((item) => item in GROUP_SCOPES);
}

const ENABLED_GROUPS = parseGroups(process.env.GWS_MCP_GROUPS);
const SCOPES = [...new Set(ENABLED_GROUPS.flatMap((group) => GROUP_SCOPES[group]))];
const SEND_ENABLED = !isOff(process.env.GWS_MCP_ALLOW_SEND ?? "1");

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const PEOPLE = "https://people.googleapis.com/v1";

// Downloaded files are confined to this directory.
const DOWNLOAD_DIR = process.env.GWS_MCP_DOWNLOAD_DIR || join(homedir(), "Downloads", "gws-mcp");
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_UPLOAD = 50 * 1024 * 1024;

// Uploads are allowed from the home directory, but never from secret stores:
// a guard against "upload ~/.ssh/id_rsa to Drive" after prompt injection.
const UPLOAD_DENY = [
  "/.ssh/",
  "/.aws/",
  "/.gnupg/",
  "/.config/",
  "/.docker/",
  "/.kube/",
  "/.netrc",
  "/.env",
  "/Library/Keychains/",
  "/.local/share/keyrings/",
];

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function loadClient() {
  let raw;
  try {
    raw = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  } catch {
    throw new Error(
      `OAuth client not found at ${CREDENTIALS_PATH}. ` +
        "Download a Desktop app client JSON from Google Cloud Console and save it there.",
    );
  }
  const client = raw.installed || raw.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error(`${CREDENTIALS_PATH} has no installed/web client_id and client_secret.`);
  }
  return client;
}

async function loadToken() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function saveToken(token) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600).catch(() => {});
}

async function tokenRequest(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token endpoint ${response.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function exchangeCode(client, code, redirectUri, verifier) {
  const data = await tokenRequest({
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

async function listenLoopback(server, startPort) {
  for (let port = startPort; port < startPort + 20; port++) {
    try {
      await new Promise((resolvePort, rejectPort) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectPort(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolvePort();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`No free port in range ${startPort}-${startPort + 19}`);
}

function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    log("Could not open a browser. Open the URL above manually.");
  }
}

function htmlPage(title, message) {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px system-ui;padding:3rem;max-width:40rem;margin:auto">` +
    `<h1>${title}</h1><p>${message}</p></body>`
  );
}

async function authorize() {
  if (!SCOPES.length) {
    throw new Error("No scopes enabled. Check GWS_MCP_GROUPS.");
  }
  const client = await loadClient();
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  let port = 0;
  let settle;
  const code = new Promise((resolveCode, rejectCode) => {
    settle = { resolve: resolveCode, reject: rejectCode };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const returned = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (error) {
      res
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(htmlPage("Authorization failed", error));
      settle.reject(new Error(`Google returned an error: ${error}`));
      return;
    }
    if (!returned || returnedState !== state) {
      res
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(htmlPage("Authorization failed", "Missing code or state mismatch."));
      settle.reject(new Error("Callback without a code or with a wrong state"));
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(htmlPage("Done", "Authorization received. You can close this tab."));
    settle.resolve(returned);
  });

  try {
    port = await listenLoopback(server, BASE_PORT);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();

    log(`Requesting scopes: ${SCOPES.join(" ")}`);
    log("Opening the browser for Google consent.");
    log(url.toString());
    openBrowser(url.toString());

    const timeout = new Promise((_, rejectTimeout) => {
      const timer = setTimeout(
        () => rejectTimeout(new Error("Timed out waiting for authorization (10 minutes)")),
        10 * 60 * 1000,
      );
      // Do not keep the process alive once the token is stored.
      timer.unref?.();
    });
    const received = await Promise.race([code, timeout]);
    const token = await exchangeCode(client, received, redirectUri, verifier);
    if (!token.refresh_token) {
      throw new Error(
        "Google did not return a refresh_token. Remove the app at " +
          "https://myaccount.google.com/connections and try again.",
      );
    }
    await saveToken(token);
    log(`Token saved to ${TOKEN_PATH}`);
    log(`Granted scopes: ${token.scope}`);
    return token;
  } finally {
    server.close();
  }
}

let refreshing;
async function accessToken(force = false) {
  const token = await loadToken();
  if (!token?.access_token) {
    throw new Error(`No token at ${TOKEN_PATH}. Run: gws-mcp --auth`);
  }
  const fresh = token.expiry_date && token.expiry_date - Date.now() > 60_000;
  if (fresh && !force) return token.access_token;
  if (!token.refresh_token) {
    throw new Error("Token has no refresh_token. Run: gws-mcp --auth");
  }
  refreshing ??= (async () => {
    const client = await loadClient();
    const data = await tokenRequest({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    });
    const next = {
      ...token,
      access_token: data.access_token,
      scope: data.scope ?? token.scope,
      token_type: data.token_type ?? token.token_type,
      expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    await saveToken(next);
    return next.access_token;
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function api(url, { method = "GET", body, rawBody, headers, retry = true } = {}) {
  const token = await accessToken();
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : rawBody,
  });
  if (response.status === 401 && retry) {
    await accessToken(true);
    return api(url, { method, body, rawBody, headers, retry: false });
  }
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || data?.raw || response.statusText;
    throw new Error(`Google API ${response.status}: ${message}`);
  }
  return data;
}

async function apiBinary(url, { retry = true } = {}) {
  const token = await accessToken();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401 && retry) {
    await accessToken(true);
    return apiBinary(url, { retry: false });
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {
      // keep the raw text
    }
    throw new Error(`Google API ${response.status}: ${message}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "",
  };
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

const decode = (data) => Buffer.from(data, "base64url").toString("utf8");

const stripHtml = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function findBody(payload, mime) {
  if (!payload) return undefined;
  if (payload.mimeType === mime && payload.body?.data) return payload.body.data;
  for (const part of payload.parts ?? []) {
    const found = findBody(part, mime);
    if (found) return found;
  }
  return undefined;
}

function headersOf(payload) {
  const out = {};
  for (const header of payload?.headers ?? []) {
    out[header.name.toLowerCase()] = header.value;
  }
  return out;
}

function bodyOf(payload) {
  const plain = findBody(payload, "text/plain");
  if (plain) return decode(plain);
  const html = findBody(payload, "text/html");
  if (html) return stripHtml(decode(html));
  return "";
}

const MAX_BODY = 20_000;

async function searchThreads({ query, maxResults = 10 } = {}) {
  const limit = Math.min(Math.max(Number(maxResults) || 10, 1), 20);
  const params = new URLSearchParams({ maxResults: String(limit) });
  if (query) params.set("q", String(query));
  const list = await api(`${GMAIL}/threads?${params}`);
  const threads = [];
  for (const item of list.threads ?? []) {
    const thread = await api(
      `${GMAIL}/threads/${item.id}?format=metadata` +
        "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date",
    );
    const messages = thread.messages ?? [];
    const last = messages[messages.length - 1] ?? {};
    const headers = headersOf(last.payload);
    threads.push({
      threadId: thread.id,
      subject: headers.subject ?? "",
      from: headers.from ?? "",
      to: headers.to ?? "",
      date: headers.date ?? "",
      messageCount: messages.length,
      snippet: last.snippet ?? "",
    });
  }
  return { count: threads.length, threads };
}

async function getThread({ threadId } = {}) {
  if (!threadId) throw new Error("threadId is required");
  const thread = await api(`${GMAIL}/threads/${encodeURIComponent(threadId)}?format=full`);
  const messages = (thread.messages ?? []).map((message) => {
    const headers = headersOf(message.payload);
    let body = bodyOf(message.payload);
    const truncated = body.length > MAX_BODY;
    if (truncated) body = `${body.slice(0, MAX_BODY)}\n\n[...truncated ${body.length - MAX_BODY} characters]`;
    return {
      id: message.id,
      from: headers.from ?? "",
      to: headers.to ?? "",
      cc: headers.cc ?? "",
      subject: headers.subject ?? "",
      date: headers.date ?? "",
      labelIds: message.labelIds ?? [],
      body,
      truncated,
    };
  });
  return { threadId: thread.id, messageCount: messages.length, messages };
}

const sanitizeHeader = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

function encodeSubject(subject) {
  const value = sanitizeHeader(subject);
  if (!value) return "";
  // RFC 2047 only for non-ASCII; plain ASCII headers are left readable.
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMessage({ to, cc, bcc, subject, body, inReplyTo }) {
  const lines = [
    `To: ${sanitizeHeader(to)}`,
    ...(cc ? [`Cc: ${sanitizeHeader(cc)}`] : []),
    ...(bcc ? [`Bcc: ${sanitizeHeader(bcc)}`] : []),
    `Subject: ${encodeSubject(subject)}`,
    ...(inReplyTo
      ? [`In-Reply-To: ${sanitizeHeader(inReplyTo)}`, `References: ${sanitizeHeader(inReplyTo)}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(String(body ?? ""), "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n"),
  ];
  return lines.join("\r\n");
}

async function createDraft({ to, subject, body, cc, bcc } = {}) {
  if (!to) throw new Error("to is required");
  if (!subject) throw new Error("subject is required");
  const raw = Buffer.from(buildMessage({ to, cc, bcc, subject, body }), "utf8").toString("base64url");
  const draft = await api(`${GMAIL}/drafts`, { method: "POST", body: { message: { raw } } });
  return {
    draftId: draft.id,
    messageId: draft.message?.id,
    note: "Draft created. Only a human can send it from Gmail.",
  };
}

async function sendEmail({ to, subject, body, cc, bcc, threadId, inReplyTo } = {}) {
  if (!to) throw new Error("to is required");
  if (!subject) throw new Error("subject is required");
  if (!String(body ?? "").trim()) throw new Error("body is required");
  const raw = Buffer.from(buildMessage({ to, cc, bcc, subject, body, inReplyTo }), "utf8").toString(
    "base64url",
  );
  const sent = await api(`${GMAIL}/messages/send`, {
    method: "POST",
    body: { raw, ...(threadId ? { threadId: String(threadId) } : {}) },
  });
  return {
    messageId: sent.id,
    threadId: sent.threadId,
    labelIds: sent.labelIds,
    note: "Message sent.",
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

async function listCalendars() {
  const data = await api(`${CALENDAR}/users/me/calendarList?maxResults=100`);
  return {
    calendars: (data.items ?? []).map((calendar) => ({
      id: calendar.id,
      summary: calendar.summary,
      primary: Boolean(calendar.primary),
      accessRole: calendar.accessRole,
      timeZone: calendar.timeZone,
    })),
  };
}

async function listEvents({ calendarId = "primary", timeMin, timeMax, maxResults = 10, query } = {}) {
  const limit = Math.min(Math.max(Number(maxResults) || 10, 1), 50);
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(limit),
    timeMin: timeMin ? String(timeMin) : new Date().toISOString(),
  });
  if (timeMax) params.set("timeMax", String(timeMax));
  if (query) params.set("q", String(query));
  const data = await api(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return {
    events: (data.items ?? []).map((event) => ({
      id: event.id,
      summary: event.summary ?? "(untitled)",
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      location: event.location,
      attendees: (event.attendees ?? []).map((attendee) => attendee.email),
      status: event.status,
      htmlLink: event.htmlLink,
    })),
  };
}

async function createEvent({
  calendarId = "primary",
  summary,
  start,
  end,
  description,
  location,
  attendees,
  timeZone,
} = {}) {
  if (!summary) throw new Error("summary is required");
  if (!start) throw new Error("start is required (ISO 8601)");
  if (!end) throw new Error("end is required (ISO 8601)");
  const body = {
    summary: sanitizeHeader(summary),
    start: { dateTime: String(start), ...(timeZone ? { timeZone } : {}) },
    end: { dateTime: String(end), ...(timeZone ? { timeZone } : {}) },
    ...(description ? { description: String(description) } : {}),
    ...(location ? { location: sanitizeHeader(location) } : {}),
    ...(Array.isArray(attendees) && attendees.length
      ? { attendees: attendees.filter(Boolean).map((email) => ({ email: String(email) })) }
      : {}),
  };
  const event = await api(
    `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
    { method: "POST", body },
  );
  return {
    eventId: event.id,
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    htmlLink: event.htmlLink,
    note: "No invitations were sent (sendUpdates=none).",
  };
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const FILE_FIELDS =
  "id,name,mimeType,size,modifiedTime,parents,webViewLink,owners(displayName,emailAddress),trashed";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const GOOGLE_EXPORT = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.script": {
    mime: "application/vnd.google-apps.script+json",
    ext: ".json",
  },
};

const escapeQuery = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function mapFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    isFolder: file.mimeType === FOLDER_MIME,
    size: file.size ? Number(file.size) : undefined,
    modifiedTime: file.modifiedTime,
    parents: file.parents ?? [],
    owner: file.owners?.[0]?.emailAddress,
    webViewLink: file.webViewLink,
  };
}

async function searchFiles({ query, folderId, maxResults = 20 } = {}) {
  const limit = Math.min(Math.max(Number(maxResults) || 20, 1), 100);
  const clauses = ["trashed = false"];
  if (query) {
    const q = escapeQuery(query);
    clauses.push(`(name contains '${q}' or fullText contains '${q}')`);
  }
  if (folderId) clauses.push(`'${escapeQuery(folderId)}' in parents`);
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: String(limit),
    fields: `files(${FILE_FIELDS})`,
    orderBy: "modifiedTime desc",
  });
  const data = await api(`${DRIVE}/files?${params}`);
  return { count: data.files?.length ?? 0, files: (data.files ?? []).map(mapFile) };
}

function safeTarget(destPath, fallbackName) {
  const base = resolve(DOWNLOAD_DIR);
  const name = String(fallbackName ?? "file")
    .replace(/[/\\\0]/g, "_")
    .slice(0, 150);
  const target = destPath ? resolve(base, String(destPath)) : resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Downloads are confined to ${base}`);
  }
  return target;
}

async function downloadFile({ fileId, destPath } = {}) {
  if (!fileId) throw new Error("fileId is required");
  const meta = await api(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`);
  const exportInfo = GOOGLE_EXPORT[meta.mimeType];
  let buffer;
  let ext = "";
  if (exportInfo) {
    ({ buffer } = await apiBinary(
      `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportInfo.mime)}`,
    ));
    ext = exportInfo.ext;
  } else if (String(meta.mimeType).startsWith("application/vnd.google-apps.")) {
    throw new Error(`Format ${meta.mimeType} cannot be downloaded directly`);
  } else {
    if (meta.size && Number(meta.size) > MAX_DOWNLOAD) {
      throw new Error(`File is larger than ${MAX_DOWNLOAD / 1024 / 1024} MB`);
    }
    ({ buffer } = await apiBinary(`${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`));
  }
  const name = meta.name ?? "file";
  const target = safeTarget(destPath, ext && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer, { mode: 0o600 });
  await chmod(target, 0o600).catch(() => {});
  return { savedTo: target, bytes: buffer.length, name, mimeType: meta.mimeType };
}

function checkUploadPath(abs) {
  const home = resolve(homedir());
  if (abs !== home && !abs.startsWith(home + sep)) {
    throw new Error(`Uploads are limited to ${home}`);
  }
  const probe = abs.toLowerCase();
  if (basename(probe).startsWith(".env")) {
    throw new Error(`Path ${abs} is blocked: looks like a secrets file`);
  }
  for (const deny of UPLOAD_DENY) {
    if (probe.includes(deny) || probe.endsWith(deny)) {
      throw new Error(`Path ${abs} is blocked: looks like a secret store`);
    }
  }
}

async function uploadFile({ localPath, name, parentId, mimeType } = {}) {
  if (!localPath) throw new Error("localPath is required");
  const abs = resolve(String(localPath));
  checkUploadPath(abs);
  const info = await stat(abs);
  if (!info.isFile()) throw new Error(`${abs} is not a file`);
  if (info.size > MAX_UPLOAD) throw new Error(`File is larger than ${MAX_UPLOAD / 1024 / 1024} MB`);
  const data = await readFile(abs);
  const boundary = `gws${randomBytes(12).toString("hex")}`;
  const metadata = {
    name: name ? String(name) : basename(abs),
    ...(parentId ? { parents: [String(parentId)] } : {}),
  };
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\ncontent-type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const file = await api(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: "POST",
      rawBody: Buffer.concat([head, data, tail]),
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
    },
  );
  return { file: mapFile(file), uploadedFrom: abs };
}

async function createFolder({ name, parentId } = {}) {
  if (!name) throw new Error("name is required");
  const file = await api(`${DRIVE}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: "POST",
    body: {
      name: String(name),
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [String(parentId)] } : {}),
    },
  });
  return { folder: mapFile(file) };
}

async function moveFile({ fileId, parentId } = {}) {
  if (!fileId) throw new Error("fileId is required");
  if (!parentId) throw new Error("parentId is required");
  const meta = await api(`${DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,name,parents`);
  const previous = meta.parents ?? [];
  const params = new URLSearchParams({ addParents: String(parentId), fields: FILE_FIELDS });
  if (previous.length) params.set("removeParents", previous.join(","));
  const file = await api(`${DRIVE}/files/${encodeURIComponent(fileId)}?${params}`, {
    method: "PATCH",
    body: {},
  });
  return { file: mapFile(file), movedFrom: previous, movedTo: String(parentId) };
}

async function trashFile({ fileId } = {}) {
  if (!fileId) throw new Error("fileId is required");
  const file = await api(
    `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    { method: "PATCH", body: { trashed: true } },
  );
  return {
    file: mapFile(file),
    note: "Moved to trash. Permanent deletion is not implemented; use the Drive web UI.",
  };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

function mapPerson(person) {
  return {
    name: person.names?.[0]?.displayName,
    emails: (person.emailAddresses ?? []).map((item) => item.value),
    phones: (person.phoneNumbers ?? []).map((item) => item.value),
  };
}

async function searchContacts({ query, maxResults = 20 } = {}) {
  if (!query) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(maxResults) || 20, 1), 30);
  const params = new URLSearchParams({
    query: String(query),
    readMask: "names,emailAddresses,phoneNumbers",
    pageSize: String(limit),
  });
  const data = await api(`${PEOPLE}/people:searchContacts?${params}`);
  return {
    count: data.results?.length ?? 0,
    contacts: (data.results ?? []).map((item) => mapPerson(item.person ?? {})),
  };
}

async function listContacts({ maxResults = 50 } = {}) {
  const limit = Math.min(Math.max(Number(maxResults) || 50, 1), 200);
  const params = new URLSearchParams({
    personFields: "names,emailAddresses,phoneNumbers",
    pageSize: String(limit),
    sortOrder: "LAST_MODIFIED_DESCENDING",
  });
  const data = await api(`${PEOPLE}/people/me/connections?${params}`);
  return { count: data.connections?.length ?? 0, contacts: (data.connections ?? []).map(mapPerson) };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const TOOL_GROUPS = {
  search_threads: "gmail",
  get_thread: "gmail",
  create_draft: "gmail",
  send_email: "gmail",
  list_calendars: "calendar",
  list_events: "calendar",
  create_event: "calendar",
  search_files: "drive",
  download_file: "drive",
  upload_file: "drive",
  create_folder: "drive",
  move_file: "drive",
  trash_file: "drive",
  search_contacts: "contacts",
  list_contacts: "contacts",
};

const ALL_TOOLS = [
  {
    name: "search_threads",
    description:
      "Search Gmail threads using Gmail query syntax (e.g. \"is:unread\", " +
      "\"from:boss@example.com newer_than:7d\"). Returns thread ids with sender, subject, date and snippet. " +
      "Does not return message bodies; use get_thread for that.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Empty string lists the newest threads." },
        maxResults: { type: "number", description: "1-20, default 10" },
      },
    },
  },
  {
    name: "get_thread",
    description:
      "Read a whole thread: headers and the text body of every message (HTML is converted to text, " +
      "bodies are truncated at 20k characters).",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string", description: "Thread id from search_threads" } },
      required: ["threadId"],
    },
  },
  {
    name: "create_draft",
    description:
      "Create a draft email. Nothing is sent; a human has to send it from Gmail.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text, no Markdown" },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email as the signed-in user. This is irreversible: the message leaves immediately. " +
      "To reply inside an existing thread, pass threadId and inReplyTo (the Message-ID header value).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient(s), comma separated" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text, no Markdown" },
        cc: { type: "string" },
        bcc: { type: "string" },
        threadId: { type: "string", description: "Thread id for a reply" },
        inReplyTo: { type: "string", description: "Message-ID of the message being replied to" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "list_calendars",
    description: "List the account's calendars with id, name and access role.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_events",
    description:
      "List calendar events in a time range. Defaults to the next 10 events starting now.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Defaults to \"primary\"" },
        timeMin: { type: "string", description: "ISO 8601, defaults to now" },
        timeMax: { type: "string", description: "ISO 8601" },
        maxResults: { type: "number", description: "1-50, default 10" },
        query: { type: "string", description: "Free-text search over events" },
      },
    },
  },
  {
    name: "create_event",
    description:
      "Create a calendar event. Times are ISO 8601; without timeZone the calendar's timezone is used. " +
      "No invitations are sent to attendees.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Defaults to \"primary\"" },
        summary: { type: "string" },
        start: { type: "string", description: "e.g. 2026-11-24T15:00:00+03:00" },
        end: { type: "string", description: "e.g. 2026-11-24T16:00:00+03:00" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" }, description: "Email addresses" },
        timeZone: { type: "string", description: "IANA name, e.g. Europe/Berlin" },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "search_files",
    description:
      "Search Google Drive files and folders by name and content. Without a query, returns recently " +
      "modified files. Returns id, name, type, size, dates, link and parents.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring of a file name or its text" },
        folderId: { type: "string", description: "Restrict the search to a folder" },
        maxResults: { type: "number", description: "1-100, default 20" },
      },
    },
  },
  {
    name: "download_file",
    description:
      "Download a Drive file. Google Docs/Sheets/Slides are exported as text or CSV. " +
      "Files are written only under the configured download directory.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        destPath: {
          type: "string",
          description: "Name or relative path inside the download directory",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "upload_file",
    description:
      "Upload a local file to Drive (max 50 MB). Paths inside secret stores " +
      "(.ssh, .aws, .config, .gnupg, .env and similar) are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute path inside the home directory" },
        name: { type: "string", description: "Name in Drive, defaults to the file name" },
        parentId: { type: "string", description: "Destination folder, defaults to My Drive" },
        mimeType: { type: "string" },
      },
      required: ["localPath"],
    },
  },
  {
    name: "create_folder",
    description: "Create a folder in Drive.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        parentId: { type: "string", description: "Parent folder, defaults to My Drive" },
      },
      required: ["name"],
    },
  },
  {
    name: "move_file",
    description: "Move a file or folder into another Drive folder.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        parentId: { type: "string", description: "New parent folder" },
      },
      required: ["fileId", "parentId"],
    },
  },
  {
    name: "trash_file",
    description:
      "Move a file or folder to the Drive trash. Permanent deletion is not implemented.",
    inputSchema: {
      type: "object",
      properties: { fileId: { type: "string" } },
      required: ["fileId"],
    },
  },
  {
    name: "search_contacts",
    description: "Search Google contacts by name, email or phone.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number", description: "1-30, default 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_contacts",
    description: "List contacts, most recently modified first.",
    inputSchema: {
      type: "object",
      properties: { maxResults: { type: "number", description: "1-200, default 50" } },
    },
  },
];

const TOOLS = ALL_TOOLS.filter((tool) => {
  const group = TOOL_GROUPS[tool.name];
  if (group && !ENABLED_GROUPS.includes(group)) return false;
  if (tool.name === "send_email" && !SEND_ENABLED) return false;
  return true;
});

const ENABLED_TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

const HANDLERS = {
  search_threads: searchThreads,
  get_thread: getThread,
  create_draft: createDraft,
  send_email: sendEmail,
  list_calendars: listCalendars,
  list_events: listEvents,
  create_event: createEvent,
  search_files: searchFiles,
  download_file: downloadFile,
  upload_file: uploadFile,
  create_folder: createFolder,
  move_file: moveFile,
  trash_file: trashFile,
  search_contacts: searchContacts,
  list_contacts: listContacts,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(message) {
  if (Array.isArray(message)) {
    for (const item of message) await handle(item);
    return;
  }
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;

  const { id, method, params } = message;
  const notification = id === undefined || id === null;

  try {
    switch (method) {
      case "initialize":
        ok(id, {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Access to Gmail (read, drafts, optional sending), Google Calendar (read and create events), " +
            "Google Drive (search, download, upload, folders, trash) and Google Contacts (read). " +
            "Permanent file deletion and permission changes are not implemented. " +
            "send_email sends immediately and irreversibly.",
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        ok(id, {});
        return;
      case "tools/list":
        ok(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params?.name;
        const handler = ENABLED_TOOL_NAMES.has(name) ? HANDLERS[name] : undefined;
        if (!handler) {
          ok(id, {
            content: [{ type: "text", text: `Unknown or disabled tool: ${name}` }],
            isError: true,
          });
          return;
        }
        try {
          const result = await handler(params?.arguments ?? {});
          ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (error) {
          ok(id, {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          });
        }
        return;
      }
      default:
        if (!notification) fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (!notification) fail(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function serve() {
  log(`v${SERVER_VERSION} started (stdio). Token: ${TOKEN_PATH}`);
  log(`Groups: ${ENABLED_GROUPS.join(", ") || "(none)"}; tools: ${TOOLS.length}`);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, "Parse error");
        continue;
      }
      void handle(message);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const HELP = `gws-mcp ${SERVER_VERSION} - Google Workspace MCP server (stdio)

Usage:
  gws-mcp              start the MCP server
  gws-mcp --auth       authorize in a browser and save the token
  gws-mcp --status     print token path, scopes and expiry
  gws-mcp --help       this message

Environment:
  GWS_MCP_HOME          config directory (default ~/.config/gws-mcp)
  GWS_MCP_CREDENTIALS   path to the OAuth client JSON
  GWS_MCP_TOKEN         path to the token file
  GWS_MCP_PORT          first loopback port to try (default 43117)
  GWS_MCP_GROUPS        gmail,calendar,drive,contacts (default all)
  GWS_MCP_DRIVE_SCOPE   full (default) or file
  GWS_MCP_ALLOW_SEND    0 to hide send_email
  GWS_MCP_DOWNLOAD_DIR  where downloads are written
`;

async function main() {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    console.log(HELP);
    return;
  }
  if (arg === "--auth") {
    await authorize();
    return;
  }
  if (arg === "--status") {
    const token = await loadToken();
    console.log(
      token
        ? JSON.stringify(
            {
              token: TOKEN_PATH,
              scopes: (token.scope ?? "").split(" ").filter(Boolean),
              groups: ENABLED_GROUPS,
              tools: TOOLS.length,
              expiry: new Date(token.expiry_date).toISOString(),
            },
            null,
            2,
          )
        : `No token at ${TOKEN_PATH}. Run: node ${process.argv[1]} --auth`,
    );
    return;
  }
  if (!SCOPES.length) {
    throw new Error("No scopes enabled. Check GWS_MCP_GROUPS.");
  }
  serve();
}

main().catch((error) => {
  log("Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
