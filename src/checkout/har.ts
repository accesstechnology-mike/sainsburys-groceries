import { SainsburysError } from "../errors.ts";
import { redactBody, redactUrl, Redactor } from "../session/redact.ts";

export interface HarEntry {
  request?: {
    method?: string;
    url?: string;
    headers?: { name?: string; value?: string }[];
    postData?: { mimeType?: string; text?: string };
  };
  response?: {
    status?: number;
    headers?: { name?: string; value?: string }[];
    content?: { mimeType?: string; text?: string };
  };
}

export interface CheckoutEndpoint {
  id: string;
  method: string;
  path: string;
  bodyKeys: string[];
}

const SENSITIVE_HEADER = /cookie|authorization|wcauthtoken|token|password/i;
const PAYMENT_KEYS = /^(cvv|cvc|pan|card_?number|cardnumber|securitycode)$/i;
const DROPPED_KEYS = /^(password|csrf|ioBlackBox)$/i;

export function parseHar(raw: string): HarEntry[] {
  const parsed = JSON.parse(raw) as { log?: { entries?: HarEntry[] } };
  if (!parsed.log || !Array.isArray(parsed.log.entries)) {
    throw new SainsburysError("site_changed", "HAR file has no log.entries array.");
  }
  return parsed.log.entries;
}

export function sanitiseHar(raw: string, redactor = new Redactor()): string {
  const parsed = JSON.parse(raw) as { log?: { entries?: HarEntry[] } };
  for (const entry of parsed.log?.entries ?? []) {
    if (entry.request?.url) entry.request.url = redactor.redact(redactUrl(entry.request.url));
    scrubHeaders(entry.request?.headers, redactor);
    scrubHeaders(entry.response?.headers, redactor);
    if (entry.request?.postData?.text) {
      entry.request.postData.text = redactor.redact(redactBody(entry.request.postData.text));
    }
    if (entry.response?.content?.text) {
      entry.response.content.text = redactor.redact(redactBody(entry.response.content.text));
    }
  }
  return JSON.stringify(parsed, null, 2);
}

export function checkoutEndpoints(entries: HarEntry[]): CheckoutEndpoint[] {
  const found: CheckoutEndpoint[] = [];
  for (const entry of entries) {
    const method = (entry.request?.method ?? "").toUpperCase();
    const url = entry.request?.url;
    if (!url || (method !== "POST" && method !== "PUT")) continue;
    let path = "";
    try {
      const parsed = new URL(url);
      if (!/sainsburys\.co\.uk$/i.test(parsed.hostname) && !parsed.hostname.endsWith(".sainsburys.co.uk")) continue;
      path = parsed.pathname;
    } catch {
      continue;
    }
    if (!/checkout|amend|confirm|place-order|placeorder/i.test(path)) continue;
    const keys = bodyKeys(entry.request?.postData?.text).filter((key) => !DROPPED_KEYS.test(key));
    found.push({ id: path.includes("confirm") ? "checkout.confirm" : `checkout.${found.length}`, method, path, bodyKeys: keys });
  }
  return found;
}

export function renderApiMap(endpoints: CheckoutEndpoint[], known: string[]): string {
  const lines = [
    "Endpoints below come from this repository's client and from HAR files passed to `scripts/import-har.ts`.",
    "A path listed here was observed in code or in a capture file. It is not a promise the live site still serves it.",
    "",
    "Live check on 13 Oct 2026 used curl_cffi Chrome impersonation and no browser.",
    "403 HTML containing Access Denied is `akamai_blocked`. HTTP 200 with `user_id` -1002 is a guest profile: unauthenticated, which this client reports as `session_expired`.",
    "",
    "## Groceries client",
    "",
    ...known.map((line) => `- ${line}`),
    "",
    "Profile and product search returned HTTP 200 under TLS impersonation while unauthenticated. Basket, slots, and orders are the paths this client already called; they were not re-checked on an authenticated session.",
    "",
    "## Auth",
    "",
    "- `GET https://account.sainsburys.co.uk/oauth2/auth` — verified 302 to `/login-init?login_challenge=<hex>`. client_id `gol`, PKCE S256, scope `openid offline gol-session`, audience `gol.sainsburys.co.uk`, redirect `https://www.sainsburys.co.uk/gol-ui/oauth/redirect`.",
    "- `POST https://account.sainsburys.co.uk/gol/login` — verified form post (`username`, `password`, `login_challenge`, `ioBlackBox`) returns 303 to `/gol/login/mfa`. `POST /login-ui/gol/login` returns 405.",
    "- MFA send and verify paths are parsed from the MFA HTML form, or from a login-ui bundle the operator saves locally. They were not called live.",
    "- `POST https://account.sainsburys.co.uk/oauth2/token` with `grant_type=refresh_token`, and `GET https://www.sainsburys.co.uk/gol-ui/oauth/refresh`, are implemented and unverified. The step that sets `WC_AUTHENTICATION_<userid>` is unverified.",
    "",
    "## Checkout confirm",
    "",
  ];
  const confirm = endpoints.find((endpoint) => endpoint.id === "checkout.confirm");
  if (!confirm) {
    lines.push("Unmapped. `checkout confirm` is a stub until a sanitised HAR contains the confirm POST.");
    lines.push("Capture one manual checkout, redact it, then run `bun scripts/import-har.ts <file.har>`.");
  } else {
    lines.push(`- \`${confirm.method} ${confirm.path}\``);
    lines.push(`- body keys (sensitive keys removed): ${confirm.bodyKeys.join(", ") || "(none)"}`);
    lines.push("- Values from the HAR are never replayed. The confirm body is filled from the current preview.");
  }
  lines.push("");
  return lines.join("\n");
}

export function paymentKey(keys: string[]): string | null {
  return keys.find((key) => PAYMENT_KEYS.test(key)) ?? null;
}

function bodyKeys(text: string | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

function scrubHeaders(headers: { name?: string; value?: string }[] | undefined, redactor: Redactor): void {
  for (const header of headers ?? []) {
    if (header.name && SENSITIVE_HEADER.test(header.name)) header.value = "[redacted]";
    else if (header.value) header.value = redactor.redact(header.value);
  }
}
