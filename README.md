# sainsburys-groceries

[![skills.sh installs](https://skills.sh/b/mike-grant/sainsburys-groceries)](https://skills.sh/mike-grant/sainsburys-groceries)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Headless TypeScript CLI and MCP server for a personal [Sainsbury's Groceries](https://www.sainsburys.co.uk/gol-ui/) account. Every request uses Chrome TLS impersonation. There is no browser in the runtime: not for sign-in, not for checkout, and not as a fallback.

> Personal-use tool. It talks to Sainsbury's unofficial groceries API with your own account. `checkout confirm` does not place an order until a sanitised HAR maps the endpoint, and it never sends card data.

## Setup

```bash
bun install
bun test          # offline smoke. No network, no credentials.
```

Node 20+ can run `node src/index.ts` the same way. The installed binary is `bin/sainsburys.js`, which prefers `dist/` and otherwise loads `src/`.

## Credentials

Read from the environment only, so `op run` can inject them. They are never written to the session file, the MFA resume file, or a trace.

| Variable | Use |
|---|---|
| `SAINSBURYS_EMAIL` or `SAINSBURYS_USERNAME` | account email |
| `SAINSBURYS_PASSWORD` | password |
| `SAINSBURYS_COOKIE` | optional cookie-header import |
| `SAINSBURYS_WCAUTHTOKEN` | optional `wcauthtoken` header |
| `SAINSBURYS_ACCESS_TOKEN` / `SAINSBURYS_REFRESH_TOKEN` | optional tokens |

```bash
op run -- bun src/index.ts login --debug
```

## Sign-in

Login is Ory Hydra at `account.sainsburys.co.uk` (`client_id=gol`, PKCE S256, scope `openid offline gol-session`). A correct password on a new client returns 303 to `/gol/login/mfa`. The one-time code is supplied in the same login, or later, without posting the password again.

```bash
# TTY: prompts once if MFA appears
SAINSBURYS_EMAIL=you@example.com SAINSBURYS_PASSWORD='...' bun src/index.ts login

# Same process, code already known
bun src/index.ts login --mfa 123456

# Same process, wait up to 5 minutes for a file
bun src/index.ts login --mfa-file /tmp/sainsburys-mfa

# After a previous login exited needs_human (resume file, no password stored)
bun src/index.ts login --mfa 123456
```

A valid established session is reused. Refresh runs before another password post. There is no daily sign-in quota. If Sainsbury's challenges or flags the account, the process exits `needs_human` (12) or `account_flagged` (15) and stops.

Cookie import, when you already have a session and do not want to sign in:

```bash
bun src/index.ts import-cookie-header "WC_AUTHENTICATION_...=...; JSESSIONID=..." -t '<wcauthtoken>'
```

`__Host-` cookies are stored host-only. Putting a Domain on them is what makes Chromium report invalid cookie fields.

## Commands

| Task | Command |
|---|---|
| who you are | `whoami` |
| search | `search "oat milk" -n 5` |
| basket | `basket view` · `basket add "<query or uid>" -q 1` · `basket remove <item_uid>` |
| amend upcoming order | `amend add "<query or uid>" -q 1` |
| slots | `slots reservation` · `slots list` · `slots book <id>` · `slots cancel` |
| orders | `orders list` · `orders find "<text>"` · `orders view <id\|latest>` |
| checkout | `checkout preview` then `checkout confirm --token <hash>` |
| refresh | `refresh` (no password) |
| Akamai check | `doctor akamai` |
| API check | `doctor api` |
| clear a sticky flag | `account-flag status` · `account-flag clear --acknowledge` |
| MCP | `mcp` or `mcp --http --port 8787` |

Global flags: `--json`, `-v` / `--verbose`, `--debug`, `--trace <path>`, `--session <path>`. `--http` exists only on `mcp` and means the local JSON-RPC server. Plain `fetch` is used inside `doctor akamai` so it can be compared with impersonation. It is not a transport for real work.

With a booked slot, `basket add` amends the upcoming order. The CLI prints `next-delivery` or `basket`.

## MCP tools

`whoami`, `search`, `basket_view`, `basket_add`, `basket_remove`, `slots_view`, `orders_view`, `checkout_preview`, `checkout_confirm`, `login`, `submit_otp`.

stdio is newline-delimited JSON-RPC `2024-11-05`. HTTP listens on `127.0.0.1` and answers `GET /health`.

## Akamai

The edge blocks the TLS/HTTP2 fingerprint, not a missing header. Plain Python `requests` and plain `fetch` get `403` HTML `Access Denied` on `/gol-ui/oauth/login` and on the profile URL. Chrome impersonation (`koonjs`, same idea as `curl_cffi` impersonate `chrome`) gets `200`. An unauthenticated profile is JSON with `user_id` `-1002`. That is a guest, not a block.

`doctor akamai` prints both labels. Exit 13 when the impersonated call is still `akamai_blocked`. Do not open a browser to get past that.

## Session files

Under `~/.sainsburys/` (or `SAINSBURYS_HOME`, or next to `--session`):

| File | What |
|---|---|
| `session.json` | cookies, `wcauthtoken`, tokens. Mode 600. `established: false` is not reused. |
| `session.json.lock` | one writer at a time |
| `mfa-resume.json` | challenge, verifier, cookies. No password. |
| `account-flagged.json` | sticky stop until `account-flag clear --acknowledge` |
| `checkout-preview.json` | token for confirm |
| `api-map.json` | confirm endpoint, after a HAR import |
| `traces/` | sanitised JSONL |

Set-Cookie from every response is merged back into the session. The jar belongs to this process. koon's own jar is off.

## Traces

`--verbose` and `--debug` write a sanitised JSONL file and print `trace: <path>` on stderr. Passwords, emails, cookies, tokens, and the login challenge are redacted. Confirm a trace does not contain the password before sending it back.

## What is still unverified live

MFA field names, the `refresh_token` grant, silent `GET /gol-ui/oauth/refresh`, how the authorization code becomes `WC_AUTHENTICATION_<userid>`, orders with the `wcauthtoken` header, checkout confirm, and how long a session lives. See [docs/architecture.md](docs/architecture.md), [docs/api-map.md](docs/api-map.md), and [docs/live-test-plan.md](docs/live-test-plan.md).

## Tests

```bash
bun test
bun run typecheck
```

Fixtures under `fixtures/` are synthetic. Tests do not call Sainsbury's.

## Disclaimer

Unofficial APIs, for personal use with your own account. Not affiliated with Sainsbury's Supermarkets Ltd.
