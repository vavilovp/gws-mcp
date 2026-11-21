# Google Cloud setup, step by step

This is the long version of step 1-4 in the README. Budget five minutes.

## 1. Create the project and OAuth client

Open <https://console.cloud.google.com/auth/overview/personal> while signed in to the Google
account you want the agent to use.

The wizard offers a *Personal* project: it creates the project and a Desktop OAuth client in
one step, and does not require app verification.

Why not the usual "External" project:

| | Personal (recommended) | External + Testing |
|---|---|---|
| Verification | not needed | not needed |
| Refresh token lifetime | until revoked or 6 months unused | **7 days** |
| "Unverified app" screen | no | yes |
| User cap | one account | 100 test users |

If you use Google Workspace and want colleagues inside your organization to use the same
project, choose **External** with user type **Internal** instead: no verification, no 7-day
expiry, limited to your organization.

## 2. Enable the APIs

One link, press **Enable**:

<https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,people.googleapis.com>

If you only need part of the feature set, enable only what you need. Calling a disabled API
returns a 403 with a direct link, so this is easy to fix later.

## 3. Download the client JSON

Open <https://console.cloud.google.com/auth/clients>, find the Desktop client and press the
download icon. You get a file named `client_secret_<numbers>.apps.googleusercontent.com.json`.

```bash
mkdir -p ~/.config/gws-mcp
mv ~/Downloads/client_secret_*.json ~/.config/gws-mcp/credentials.json
chmod 600 ~/.config/gws-mcp/credentials.json
```

The file must contain an `installed` object with `client_id` and `client_secret`. A `web`
object only works for web clients; if you see one, create a Desktop client instead.

## 4. Authorize

```bash
node /path/to/gws-mcp/server.mjs --auth
```

What happens:

1. a loopback HTTP server starts on `127.0.0.1:43117` (next free port if busy);
2. the browser opens Google's consent screen;
3. after approval, the code is exchanged for an access and refresh token;
4. the token is written to `~/.config/gws-mcp/token.json` with mode `0600`.

The consent screen lists the scopes from the enabled groups. If you see Drive access, that is
the `drive` group; disable it with `GWS_MCP_GROUPS=gmail,calendar` before running `--auth` if
you do not want it.

Check the result:

```bash
node /path/to/gws-mcp/server.mjs --status
```

```json
{
  "token": "/Users/you/.config/gws-mcp/token.json",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly", "..."],
  "groups": ["gmail", "calendar", "drive", "contacts"],
  "tools": 15,
  "expiry": "2026-11-21T13:40:26.075Z"
}
```

## 5. Add the server to your client

See the README section *Connect your MCP client*. The important part is that the command runs
the same file you authorized:

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

## Revoking access

- Revoke for this app only: <https://myaccount.google.com/connections>, find the app created
  in step 1, remove access. The local token becomes useless.
- Remove it locally: `rm ~/.config/gws-mcp/token.json`.
- Delete the project entirely:
  <https://console.cloud.google.com/iam-admin/settings>.

## Common errors

**`invalid_grant`** — token expired or revoked. With External + Testing this happens every
seven days; move to Personal mode. Otherwise re-run `--auth`.

**`redirect_uri_mismatch`** — the client is not of type Desktop app. Create a new one.

**`Access blocked: app has not completed the verification process`** — the project is
External and the account is not listed as a test user. Add it under
<https://console.cloud.google.com/auth/audience>, or use Personal mode.

**`API has not been used in project ... or it is disabled`** — step 2 was skipped for that
API. The error message contains the exact link.

**`No free port in range 43117-43136`** — something else is listening. Set
`GWS_MCP_PORT=44000` and retry.
