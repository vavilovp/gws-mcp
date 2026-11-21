# gws-mcp

A small Google Workspace MCP server for Gmail, Google Calendar, Google Drive and Google Contacts.

One file, zero dependencies, Node 18+. Tokens stay on your machine. Every API call goes
directly from your computer to Google.

```bash
npx github:vavilovp/gws-mcp --auth
```

[![CI](https://github.com/vavilovp/gws-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vavilovp/gws-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why

Google ships official Gmail and Calendar MCP endpoints, but they are gated behind the
Workspace Developer Preview Program: you have to apply and wait. Hosted aggregators such as
Composio work today, but they hold your OAuth refresh tokens and log tool payloads on their
servers.

This server talks to the regular, generally available Google REST APIs instead. That means:

- no preview application, no vendor account, no third party in the path;
- the OAuth client, refresh token and every request belong to you;
- you can read the entire implementation in one sitting;
- the tool set is deliberately narrow: no permanent deletion, no sharing settings,
  no mailbox-wide labels or filters.

## Tools

| Group | Tool | What it does |
|---|---|---|
| Gmail | `search_threads` | Search threads with Gmail query syntax |
| Gmail | `get_thread` | Read full thread with text bodies |
| Gmail | `create_draft` | Create a draft, nothing is sent |
| Gmail | `send_email` | Send immediately (can be disabled) |
| Calendar | `list_calendars` | List calendars |
| Calendar | `list_events` | List events in a time range |
| Calendar | `create_event` | Create an event, no invitations sent |
| Drive | `search_files` | Search files and folders by name and content |
| Drive | `download_file` | Download or export a file to a local directory |
| Drive | `upload_file` | Upload a local file (secret stores are blocked) |
| Drive | `create_folder` | Create a folder |
| Drive | `move_file` | Move a file or folder |
| Drive | `trash_file` | Move to trash; permanent deletion is not implemented |
| Contacts | `search_contacts` | Search by name, email or phone |
| Contacts | `list_contacts` | List contacts |

## Requirements

- Node.js 18 or newer
- A Google account
- An OAuth client of type **Desktop app**

## Setup

It takes about five minutes. The most important choice is at step 1.

### 1. Create a Google Cloud project in Personal mode

Open **<https://console.cloud.google.com/auth/overview/personal>** and follow the wizard.
It creates a project and a Desktop OAuth client for the single Google account you are signed
in with.

> **Use Personal mode, not External + Testing.** An External project in Testing status issues
> refresh tokens that expire after **7 days**, so you would have to re-authorize every week.
> Personal mode has no verification requirement, no 7-day expiry, no "unverified app" screen
> and no 100-user cap. It is limited to the account that created it, which is exactly what a
> personal MCP server needs.
>
> Google Workspace users can instead create an External project with user type **Internal**:
> same benefits, limited to the organization.

### 2. Enable the APIs

Open this link and press **Enable**:

<https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,people.googleapis.com>

If you only plan to use some groups, enable only what you need:

| Group | API |
|---|---|
| Gmail | `gmail.googleapis.com` |
| Calendar | `calendar-json.googleapis.com` |
| Drive | `drive.googleapis.com` |
| Contacts | `people.googleapis.com` |

### 3. Download the OAuth client

Go to **<https://console.cloud.google.com/auth/clients>**, open the Desktop client and
download the JSON. Then:

```bash
mkdir -p ~/.config/gws-mcp
mv ~/Downloads/client_secret_*.json ~/.config/gws-mcp/credentials.json
chmod 600 ~/.config/gws-mcp/credentials.json
```

### 4. Authorize

```bash
node /path/to/gws-mcp/server.mjs --auth
```

or, without cloning:

```bash
npx github:vavilovp/gws-mcp --auth
```

A browser opens, you approve the requested scopes, and the token is written to
`~/.config/gws-mcp/token.json` with mode `0600`. Check it with:

```bash
node /path/to/gws-mcp/server.mjs --status
```

### 5. Connect your MCP client

**OpenCode** (`~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "gws": {
        "type": "local",
        "command": ["node", "/path/to/gws-mcp/server.mjs"]
      }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gws": {
      "command": "npx",
      "args": ["-y", "github:vavilovp/gws-mcp"]
    }
  }
}
```

Any client that speaks MCP over stdio works: the server reads JSON-RPC lines on stdin and
writes them to stdout. Logs go to stderr.

## Scopes and groups

By default the server requests all four groups:

| Group | Scopes |
|---|---|
| `gmail` | `gmail.readonly`, `gmail.compose` |
| `calendar` | `calendar.calendarlist.readonly`, `calendar.events` |
| `drive` | `drive` (or `drive.file` with `GWS_MCP_DRIVE_SCOPE=file`) |
| `contacts` | `contacts.readonly` |

Choose what you need with `GWS_MCP_GROUPS`:

```json
{
  "mcp": {
    "servers": {
      "gws": {
        "type": "local",
        "command": ["node", "/path/to/gws-mcp/server.mjs"],
        "env": { "GWS_MCP_GROUPS": "gmail,calendar" }
      }
    }
  }
}
```

Disabled groups disappear from `tools/list`, so the model cannot call them at all. If the
token was issued earlier, re-run `--auth` after changing groups.

Notes on scope choices:

- `gmail.compose` covers both drafts and sending. To remove sending entirely, either set
  `GWS_MCP_ALLOW_SEND=0` or deny the tool in your client.
- `drive` is a **restricted** scope. It is the only way to trash and move arbitrary files.
  `GWS_MCP_DRIVE_SCOPE=file` requests `drive.file` instead: non-restricted, but the app then
  only sees files it created or that you explicitly opened with it.
- `gmail.readonly`, `gmail.compose` and `drive` are restricted scopes. Using them in your own
  Personal-mode project is fine, but a *public* app requesting them would need Google
  verification and a yearly CASA security assessment. This is why the project ships as
  source code with a per-user OAuth client instead of a shared one.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GWS_MCP_HOME` | `~/.config/gws-mcp` | Config directory |
| `GWS_MCP_CREDENTIALS` | `$GWS_MCP_HOME/credentials.json` | OAuth client JSON |
| `GWS_MCP_TOKEN` | `$GWS_MCP_HOME/token.json` | Token file |
| `GWS_MCP_PORT` | `43117` | First loopback port to try for the OAuth callback |
| `GWS_MCP_GROUPS` | `gmail,calendar,drive,contacts` | Enabled feature groups |
| `GWS_MCP_DRIVE_SCOPE` | `full` | `full` (`drive`) or `file` (`drive.file`) |
| `GWS_MCP_ALLOW_SEND` | `1` | `0` hides `send_email` |
| `GWS_MCP_DOWNLOAD_DIR` | `~/Downloads/gws-mcp` | Where `download_file` writes |

## CLI

```
gws-mcp              start the MCP server (stdio)
gws-mcp --auth       authorize in a browser and save the token
gws-mcp --status     print token path, scopes, groups and expiry
gws-mcp --help       usage
```

## Security model

**Tokens.** The refresh token is stored locally at `~/.config/gws-mcp/token.json`, mode
`0600`, and is only sent to `oauth2.googleapis.com`. No telemetry, no analytics, no update
checks.

**No third party.** Requests go straight to `gmail.googleapis.com`,
`www.googleapis.com` and `people.googleapis.com`.

**Not implemented on purpose.** There is no `files.delete` (only trashing), no
`permissions.create` (no sharing or changing access), no Gmail settings or filters, no
`users.watch` and no webhook endpoint.

**File system boundaries.** `download_file` writes only inside the configured download
directory. `upload_file` accepts only paths inside your home directory and rejects known
secret stores (`.ssh`, `.aws`, `.config`, `.gnupg`, `.docker`, `.kube`, `.netrc`, `.env*`,
Keychain). This is a speed bump against prompt injection, not a sandbox.

**Prompt injection is the real risk.** Email bodies and documents are untrusted input. A
message can contain instructions that the model may follow, including calling `send_email`
or uploading a file. Mitigations:

- hide the tool: `GWS_MCP_ALLOW_SEND=0`, or add a client-side permission rule
  (`{"action": "gws_send_email", "resource": "*", "effect": "deny"}` in OpenCode);
- ask before tools run, if your client supports approvals;
- keep the drive scope at `file` if you do not need to move or trash arbitrary files.

See [SECURITY.md](SECURITY.md) for the full threat model.

## Troubleshooting

**`invalid_grant: Token has been expired or revoked`** — most often a project in External +
Testing status, where refresh tokens die after 7 days. Move the app to Personal (or Internal
for Workspace) and run `--auth` again. Other causes: you revoked access, changed your Google
password (this revokes Gmail-scoped tokens), or the token went unused for six months.

**`Access blocked: This app's request is invalid` / `redirect_uri_mismatch`** — the OAuth
client is not a Desktop app client. Create a new client of type Desktop app and download its
JSON again.

**`Google API 403: ... API has not been used in project ... or it is disabled`** — enable the
API from step 2, then wait a minute. The message contains a direct link with your project id.

**`Unknown or disabled tool: send_email`** — set by `GWS_MCP_ALLOW_SEND=0`, or the tool is
filtered by your client's permission rules.

**`No token at ...`** — run `--auth` once before starting the server.

**Port already in use** — the server tries ports `43117`-`43136`. Set `GWS_MCP_PORT` to start
elsewhere. Desktop OAuth clients accept any loopback port, so no console change is needed.

## Development

```bash
npm run check   # node --check server.mjs
npm test        # MCP handshake smoke test, no Google account needed
```

The smoke test spawns the server, performs `initialize` and `tools/list`, and checks the tool
list. It never calls Google.

## License

MIT. See [LICENSE](LICENSE).
