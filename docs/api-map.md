Endpoints below come from this repository's client and from HAR files passed to `scripts/import-har.ts`.
A path listed here was observed in code or in a capture file. It is not a promise the live site still serves it.

Live check on 13 Oct 2026 used curl_cffi Chrome impersonation and no browser.
403 HTML containing Access Denied is `akamai_blocked`. HTTP 200 with `user_id` -1002 is a guest profile: unauthenticated, which this client reports as `session_expired`.

## Groceries client

- GET /groceries-api/gol-services/product/v1/product
- GET /groceries-api/gol-services/customer/v1/customer/profile
- GET|POST|PUT|DELETE /groceries-api/gol-services/basket/v2/basket
- GET|POST|DELETE /groceries-api/gol-services/slot/v1/slot/reservation
- GET /groceries-api/gol-services/slot/v1/slots
- GET /groceries-api/gol-services/order/v1/order
- GET https://account.sainsburys.co.uk/oauth2/auth
- POST https://account.sainsburys.co.uk/gol/login
- POST https://account.sainsburys.co.uk/oauth2/token

Profile and product search returned HTTP 200 under TLS impersonation while unauthenticated. Basket, slots, and orders are the paths this client already called; they were not re-checked on an authenticated session.

## Auth

- `GET https://account.sainsburys.co.uk/oauth2/auth` — verified 302 to `/login-init?login_challenge=<hex>`. client_id `gol`, PKCE S256, scope `openid offline gol-session`, audience `gol.sainsburys.co.uk`, redirect `https://www.sainsburys.co.uk/gol-ui/oauth/redirect`.
- `POST https://account.sainsburys.co.uk/gol/login` — verified form post (`username`, `password`, `login_challenge`, `ioBlackBox`) returns 303 to `/gol/login/mfa`. `POST /login-ui/gol/login` returns 405.
- MFA send and verify paths are parsed from the MFA HTML form, or from a login-ui bundle the operator saves locally. They were not called live.
- `POST https://account.sainsburys.co.uk/oauth2/token` with `grant_type=refresh_token`, and `GET https://www.sainsburys.co.uk/gol-ui/oauth/refresh`, are implemented and unverified. The step that sets `WC_AUTHENTICATION_<userid>` is unverified.

## Checkout confirm

Unmapped. `checkout confirm` is a stub until a sanitised HAR contains the confirm POST.
Capture one manual checkout, redact it, then run `bun scripts/import-har.ts <file.har>`.
