#!/usr/bin/env node
/**
 * Smoke test: speaks MCP over stdio to server.mjs and checks the tool surface.
 * Does not touch Google and does not need credentials.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(root, "server.mjs");

const ALL_TOOLS = [
  "create_draft",
  "create_event",
  "create_folder",
  "download_file",
  "get_thread",
  "list_calendars",
  "list_contacts",
  "list_events",
  "move_file",
  "search_contacts",
  "search_files",
  "search_threads",
  "send_email",
  "trash_file",
  "upload_file",
].sort();

function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  let buffer = "";
  let nextId = 0;
  let stderr = "";
  const pending = new Map();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
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
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });

  child.on("exit", (code) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`server exited with ${code} before answering id ${id}\n${stderr}`));
    }
    pending.clear();
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}\n${stderr}`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const notify = (method) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };

  const stop = () =>
    new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    });

  return { request, notify, stop };
}

async function handshake(server) {
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "gws-mcp-smoke", version: "1.0.0" },
  });
  assert.equal(init.result.serverInfo.name, "gws-mcp", "server name");
  assert.ok(init.result.serverInfo.version, "server version");
  assert.equal(init.result.protocolVersion, "2025-06-18", "protocol version");
  server.notify("notifications/initialized");
  return init.result;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("default configuration exposes all 15 tools", async () => {
  const server = startServer();
  try {
    await handshake(server);
    const list = await server.request("tools/list", {});
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ALL_TOOLS);
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} has an object schema`);
      assert.ok(tool.description.length > 10, `${tool.name} has a description`);
    }
  } finally {
    await server.stop();
  }
});

test("GWS_MCP_GROUPS filters scopes and tools", async () => {
  const server = startServer({ GWS_MCP_GROUPS: "gmail" });
  try {
    await handshake(server);
    const list = await server.request("tools/list", {});
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["create_draft", "get_thread", "search_threads", "send_email"]);
  } finally {
    await server.stop();
  }
});

test("GWS_MCP_ALLOW_SEND=0 hides send_email", async () => {
  const server = startServer({ GWS_MCP_ALLOW_SEND: "0" });
  try {
    await handshake(server);
    const list = await server.request("tools/list", {});
    const names = list.result.tools.map((tool) => tool.name);
    assert.ok(!names.includes("send_email"), "send_email is hidden");
    assert.ok(names.includes("create_draft"), "create_draft stays");
  } finally {
    await server.stop();
  }
});

test("unknown and disabled tools are rejected", async () => {
  const server = startServer({ GWS_MCP_ALLOW_SEND: "0" });
  try {
    await handshake(server);
    const unknown = await server.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknown.result.isError, true);
    const disabled = await server.request("tools/call", { name: "send_email", arguments: {} });
    assert.equal(disabled.result.isError, true);
    assert.match(disabled.result.content[0].text, /disabled/);
  } finally {
    await server.stop();
  }
});

test("ping and unknown methods", async () => {
  const server = startServer();
  try {
    await handshake(server);
    const pong = await server.request("ping", {});
    assert.deepEqual(pong.result, {});
    const missing = await server.request("no/such/method", {});
    assert.equal(missing.error.code, -32601);
  } finally {
    await server.stop();
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(String(error?.stack ?? error));
  }
}

if (failed) {
  console.error(`\n${failed} of ${tests.length} tests failed`);
  process.exit(1);
}
console.log(`\n${tests.length} tests passed`);
