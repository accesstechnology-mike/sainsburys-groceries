import { BASE_URL } from "../config.ts";
import type { SessionCookie } from "../types.ts";

const HOST_ONLY_DEFAULT = new URL(BASE_URL).hostname;

export function findWcauthtoken(cookies: SessionCookie[]): string {
  let value = "";
  for (const cookie of cookies) {
    if (cookie.name.startsWith("WC_AUTHENTICATION_")) value = cookie.value;
  }
  return value;
}

/**
 * Parse a Cookie request header copied from devtools.
 * `__Host-` cookies are stored host-only (no Domain). Importing them with a
 * Domain attribute is what produced "Invalid cookie fields".
 */
export function parseCookieHeader(header: string, requestUrl = BASE_URL): SessionCookie[] {
  const host = safeHost(requestUrl) ?? HOST_ONLY_DEFAULT;
  const out: SessionCookie[] = [];
  for (const part of header.split(/;\s*/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name || !value) continue;
    out.push(cookieFromPair(name, value, host));
  }
  return out;
}

export function buildCookieHeader(cookies: SessionCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Cookie header for one request URL, honouring host-only and Domain. */
export function cookieHeaderForUrl(cookies: SessionCookie[], url: string): string {
  let request: URL;
  try {
    request = new URL(url);
  } catch {
    return buildCookieHeader(cookies);
  }
  return buildCookieHeader(cookies.filter((cookie) => cookieMatches(cookie, request)));
}

export function cookieMatches(cookie: SessionCookie, url: URL): boolean {
  const path = cookie.path ?? "/";
  if (path !== "/" && !url.pathname.startsWith(path)) return false;
  if (isHostOnly(cookie)) {
    const host = cookie.host ?? HOST_ONLY_DEFAULT;
    return url.hostname === host;
  }
  const domain = (cookie.domain ?? "sainsburys.co.uk").replace(/^\./, "").toLowerCase();
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

export function isHostOnly(cookie: SessionCookie): boolean {
  return cookie.hostOnly === true || cookie.name.startsWith("__Host-");
}

export function applySetCookies(
  existing: SessionCookie[],
  setCookieLines: string[],
  requestUrl: string,
  nowMs = Date.now(),
): SessionCookie[] {
  let cookies = existing.slice();
  for (const line of setCookieLines) {
    const parsed = parseSetCookie(line, requestUrl, nowMs);
    if (!parsed) continue;
    cookies = mergeCookie(cookies, parsed.cookie, parsed.remove);
  }
  return cookies;
}

export function parseSetCookie(
  line: string,
  requestUrl: string,
  nowMs = Date.now(),
): { cookie: SessionCookie; remove: boolean } | null {
  const parts = line.split(";").map((part) => part.trim()).filter(Boolean);
  const first = parts[0];
  if (!first) return null;
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const host = safeHost(requestUrl) ?? HOST_ONLY_DEFAULT;
  const cookie = cookieFromPair(name, value, host);
  let maxAge: number | undefined;
  let expiresAt: number | undefined;

  for (const attr of parts.slice(1)) {
    const [rawKey, ...rest] = attr.split("=");
    const key = rawKey?.trim().toLowerCase() ?? "";
    const attrValue = rest.join("=").trim();
    if (key === "domain" && !isHostOnly(cookie)) cookie.domain = attrValue || cookie.domain;
    if (key === "path" && !cookie.name.startsWith("__Host-")) cookie.path = attrValue || "/";
    if (key === "httponly") cookie.httpOnly = true;
    if (key === "secure") cookie.secure = true;
    if (key === "samesite") {
      const site = attrValue.toLowerCase();
      cookie.sameSite = site === "strict" ? "Strict" : site === "none" ? "None" : "Lax";
    }
    if (key === "max-age") {
      const parsed = Number(attrValue);
      if (Number.isFinite(parsed)) maxAge = parsed;
    }
    if (key === "expires") {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }

  if (cookie.name.startsWith("__Host-")) {
    delete cookie.domain;
    cookie.hostOnly = true;
    cookie.host = host;
    cookie.path = "/";
    cookie.secure = true;
  }

  let remove = false;
  if (maxAge !== undefined) {
    if (maxAge <= 0) remove = true;
    else cookie.expires = Math.floor(nowMs / 1000) + maxAge;
  } else if (expiresAt !== undefined) {
    cookie.expires = Math.floor(expiresAt / 1000);
    if (expiresAt <= nowMs) remove = true;
  }
  if (value === "" && maxAge === 0) remove = true;
  return { cookie, remove };
}

function mergeCookie(existing: SessionCookie[], incoming: SessionCookie, remove: boolean): SessionCookie[] {
  const key = cookieKey(incoming);
  const idx = existing.findIndex((cookie) => cookieKey(cookie) === key);
  if (remove) {
    if (idx < 0) return existing;
    return existing.filter((_, index) => index !== idx);
  }
  if (idx >= 0) {
    const next = existing.slice();
    next[idx] = incoming;
    return next;
  }
  return existing.concat(incoming);
}

function cookieKey(cookie: SessionCookie): string {
  const scope = isHostOnly(cookie) ? `host:${cookie.host ?? HOST_ONLY_DEFAULT}` : `domain:${cookie.domain ?? ""}`;
  return `${cookie.name}|${scope}|${cookie.path ?? "/"}`;
}

function cookieFromPair(name: string, value: string, host: string): SessionCookie {
  if (name.startsWith("__Host-")) {
    return {
      name,
      value,
      path: "/",
      secure: true,
      httpOnly: true,
      hostOnly: true,
      host,
    };
  }
  return {
    name,
    value,
    domain: ".sainsburys.co.uk",
    path: "/",
    secure: true,
    httpOnly: name.startsWith("WC_") || name === "JSESSIONID",
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
