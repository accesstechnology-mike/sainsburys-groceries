---
name: sainsburys-groceries
description: Headless Sainsbury's Groceries access from the CLI or MCP. Search products, view and edit the basket, view slots and orders, preview checkout. TLS impersonation only. No browser. Credentials come from the environment.
license: MIT
---

# Sainsbury's Groceries

The CLI is a separate install. This file is the agent instructions.

## Setup

```bash
bun install
bun test
```

Or `bash "<this-skill-dir>/scripts/bootstrap.sh"` when the published package is already current. From a clone: `bun <repo>/src/index.ts <command>`. Add `--json` for machine-readable output.

## Credentials

`SAINSBURYS_EMAIL` (or `SAINSBURYS_USERNAME`) and `SAINSBURYS_PASSWORD` from the environment, typically `op run`. Never put them in argv, a session file, or a log. Never ask the user to paste a password into the chat if `op run` is available.

## Sign-in

There is no browser and no daily sign-in quota. A valid session is reused. Refresh runs before another password post.

```bash
op run -- bun src/index.ts login --debug
```

If the error starts with `MFA_REQUIRED` (exit 12):

1. Stop. Do not run `login` without `--mfa` or `--mfa-file`. That would post the password again.
2. Ask the user for the one-time code.
3. Continue the same resume file:

```bash
op run -- bun src/index.ts login --mfa-file /tmp/sainsburys-otp --debug
printf '%s\n' '<code from user>' > /tmp/sainsburys-otp
```

MCP `submit_otp` with `{ "code": "<code>" }` does the same thing. Then `whoami`. A guest `user_id` of `-1002` is not signed in.

`import-cookie-header` is only for a cookie header the user already exported. Do not open a browser to obtain one.

## Commands

| Task | Command |
|---|---|
| Profile | `whoami` |
| Search | `search "<query>" -n 5` |
| Basket | `basket view` · `basket add "<uid or query>" -q 1` · `basket remove <item_uid>` |
| Amend | `amend add "<uid or query>" -q 1` |
| Slots | `slots reservation` · `slots list` |
| Orders | `orders list` · `orders find "<text>"` · `orders view <id>` |
| Preview | `checkout preview` |
| Confirm | `checkout confirm --token <hash>` only after the account owner says yes |
| Akamai | `doctor akamai` |
| Flag | `account-flag status` |

Global: `--json`, `--debug`, `--session <path>`. `--debug` prints `trace: <path>`.

## Rules

- Booked slot: `basket add` amends the upcoming order (`next-delivery`). Say which target was used.
- Before adding, `search`, then `basket view`. Add a `product_uid` that is not already in the basket. Remove that new `item_uid` when the user only wanted a test. If every hit is already in the basket, stop and do not change quantities.
- `checkout confirm` without a HAR map exits `checkout_unmapped` and posts nothing. Do not work around that.
- Exit 13 `akamai_blocked`: stop. Do not launch a browser.
- Exit 15 `account_flagged`: stop until a person runs `account-flag clear --acknowledge`.
- Exit 16 `payment_challenge`: stop. Do not collect a card or CVV.
- Anonymous profile JSON uses `user_id` `-1002` with HTTP 200. Status alone is not success.
- Do not book or cancel a slot, and do not confirm checkout, unless the user asked for that exact action.
