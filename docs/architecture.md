# Architecture

Headless access to the Sainsbury's groceries site. The runtime is Bun or Node, TypeScript, and `koonjs` Chrome TLS impersonation. No browser is loaded for sign-in, basket, slots, orders, or checkout. `scripts/har-capture.sh` can start Chrome on a desktop so a person can export a HAR. The CLI never attaches to it.

## Transport

Akamai gates on the TLS/HTTP2 fingerprint. Checked 13 Oct 2026 with no browser:

- Plain Python `requests`: `GET /gol-ui/oauth/login` and `GET /groceries-api/gol-services/customer/v1/customer/profile` return 403 HTML `Access Denied`.
- `curl_cffi` with `impersonate='chrome'`: both return 200. The unauthenticated profile is guest JSON (`user_id` `-1002`). Product search returns 200.

This client uses `koonjs` the same way for every real request. Plain `fetch` exists only inside `doctor akamai`, so a block can be told apart from an expired session. Cookie storage is ours. koon's cookie jar is disabled. `__Host-` cookies are host-only (no `Domain`). `WC_AUTHENTICATION_*` supplies the `wcauthtoken` header (last match). Set-Cookie is merged after every response and written to the session file (mode 600, atomic rename).

A file lock (exclusive create, stale after 180s or a dead pid) serialises concurrent callers.

## Sign-in

Ory Hydra at `account.sainsburys.co.uk`.

1. PKCE S256. `state` and `nonce` are 24 random bytes, base64url.
2. `GET /oauth2/auth` with `client_id=gol`, `scope=openid offline gol-session`, `audience=gol.sainsburys.co.uk`, `redirect_uri=https://www.sainsburys.co.uk/gol-ui/oauth/redirect`. Verified: 302 to `/login-init?login_challenge=<hex>`. `LOGIN_RECAPTCHA_ENABLED=false`. `missionId=gol` and `response_mode=query` come from a public authorize URL and were not the thing re-checked on 13 Oct.
3. Credential `POST` is form-urlencoded `username`, `password`, `login_challenge`, `ioBlackBox=` (empty is accepted) to `/gol/login`. Verified: 303 to `/gol/login/mfa`. `POST /login-ui/gol/login` returns 405 and is not called.
4. The MFA HTML form is parsed (code field, hidden fields, remember-device checkbox). If a local bundle map has a send-otp path, that POST runs once. Without a map, send-otp is not called. No send-otp request has been seen live.
5. No code: write `mfa-resume.json` (cookies, challenge, verifier; no password) and exit `needs_human`. A later `login --mfa`, `login --mfa-file`, or MCP `submit_otp` continues that resume and does not post the password again.
6. With a code: POST the form, follow redirects, require `code` and a matching `state` on the redirect URI.
7. `POST /oauth2/token` with `grant_type=authorization_code` (no client secret), then `GET` the redirect URI for `WC_AUTHENTICATION_*`. That order, and whether the GET consumes the code, is not verified. Tokens without a WC cookie are saved with `established: false` and are not reused. A profile that is still a guest is `site_changed`.

`ioBlackBox` is sent empty because the live trace accepted that. A blackbox value is not invented.

## Refresh

`offline` is in the scope, so Hydra should issue a `refresh_token`. Implemented, not verified, because MFA has not been passed:

1. `POST /oauth2/token` with `grant_type=refresh_token` and `client_id=gol`.
2. If that does not extend the session, `GET /gol-ui/oauth/refresh` and follow redirects. A 4xx stops. A landing on the password form stops.
3. If that path never entered `/oauth2/auth`, one `prompt=none` authorize is tried.

A password is never posted from refresh. `invalid_grant` does not wipe cookies. A public write-up (Liam Day) reported the refresh grant refused and cookies dying in about an hour. Both paths exist so the live probe can show which one, if either, works.

Before any authed job: reuse an established session whose profile is a real user, else refresh, else sign in when credentials are in the environment and the command allows it. Search does not require a session. `doctor`, `refresh`, and the session-life probe do not sign in.

There is no daily sign-in limit and no quota file. Sign in as often as the work needs. A block, challenge, or account flag from Sainsbury's is reported. It is not a pre-set rule.

## Checkout

`checkout preview` canonicalises basket lines (sorted), slot, and totals, stores a SHA-256 token in `checkout-preview.json`, and posts nothing. `checkout confirm --token` requires that stored token and a recomputed hash of the current basket. A mismatch is `preview_mismatch` and nothing is posted.

With no map, confirm is `checkout_unmapped` and nothing is posted. `scripts/import-har.ts` reads a HAR the operator saved, writes a sanitised copy, `api-map.json`, and rewrites `docs/api-map.md`. It does not call Sainsbury's. Confirm body keys come from the map. Values come from the current preview. HAR body values are never replayed. Keys named cvv, cvc, pan, or card number refuse with `payment_challenge` before any send. `password`, `csrf`, and `ioBlackBox` are dropped from the map.

## Failure modes

| Code | Exit | When | What the caller does |
|---|---|---|---|
| `session_expired` | 10 | No session, 401, or profile `user_id` <= 0 including guest `-1002` | Refresh, then sign in if this command is allowed to |
| `needs_human` | 12 | MFA with no code, captcha, or bot challenge | Stop. Send the trace. Continue with the resume file and one OTP. Do not post the password again |
| `akamai_blocked` | 13 | 403/503 HTML Access Denied, Akamai, or edgesuite | Stop. `doctor akamai`. Do not switch to a browser |
| `site_changed` | 14 | Unexpected login redirect, basket body that is not a basket, unmapped slot shape, login that stays a guest | Stop. No further basket writes |
| `account_flagged` | 15 | Suspended or locked wording, then a sticky flag file | Every API command stops until `account-flag clear --acknowledge` |
| `payment_challenge` | 16 | CVV, 3DS, or a confirm body that asks for card fields | Stop. No card data is sent |
| `checkout_unmapped` | 17 | Confirm with no HAR map | Stop. Nothing posted |
| `preview_mismatch` | 18 | Token missing or basket/slot/total changed | Run preview again |

Other errors exit 1.

## Session-life probe

`bun scripts/session-life-probe.ts --interval 5m --duration 70m` calls profile on the saved session. It never signs in. When the profile is a guest or 401 it tries refresh once. JSONL records `alive`, `refresh_extended`, `session_died`, `akamai_blocked`, `needs_human`, or `account_flagged`. It stops on the first outcome that is not alive or extended. Exit 10 if the last record is not alive or extended. Lifetime has not been measured. There is no authenticated session yet.

## Open questions

- Does a second password post on an untrusted client always return MFA, or does a remembered-device cookie skip it the next time?
- Does repeated sign-in get the account flagged? The client does not guess. It stops when the site says so.
- Does `grant_type=refresh_token` succeed, and does `GET /gol-ui/oauth/refresh` mint `WC_AUTHENTICATION_*`?
- Can checkout complete with the mapped POST alone, or does the site demand a browser challenge after preview?

The Dockerfile still describes the old `impers` image and is not the path this runtime uses.
