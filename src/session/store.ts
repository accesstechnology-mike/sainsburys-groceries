import fs from "node:fs";
import path from "node:path";
import { defaultSessionPath } from "../config.ts";
import type { Session, SessionCookie } from "../types.ts";
import { findWcauthtoken, parseCookieHeader, buildCookieHeader } from "./cookies.ts";

export { findWcauthtoken, parseCookieHeader, buildCookieHeader, cookieHeaderForUrl, applySetCookies } from "./cookies.ts";

export function loadSession(sessionPath = defaultSessionPath()): Session | null {
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Session;
    if (!parsed.cookies?.length && !parsed.accessToken && !parsed.refreshToken) return null;
    if (!parsed.cookies) parsed.cookies = [];
    if (!parsed.wcauthtoken) parsed.wcauthtoken = findWcauthtoken(parsed.cookies);
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: Session, sessionPath = defaultSessionPath()): string {
  if (!session.wcauthtoken) session.wcauthtoken = findWcauthtoken(session.cookies);
  const persisted = sessionForDisk(session);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
  const tmp = `${sessionPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, sessionPath);
  fs.chmodSync(sessionPath, 0o600);
  return sessionPath;
}

/** Passwords and emails are never part of the session type; this drops them if a caller stuffed them on. */
function sessionForDisk(session: Session): Session {
  const copy = { ...session, cookies: session.cookies.map((cookie) => ({ ...cookie })) };
  const extra = copy as Session & { password?: unknown; email?: unknown };
  delete extra.password;
  delete extra.email;
  return copy;
}

export function deleteSession(sessionPath = defaultSessionPath()): boolean {
  try {
    fs.unlinkSync(sessionPath);
    return true;
  } catch {
    return false;
  }
}

export function buildCookieHeaderFromSession(cookies: SessionCookie[]): string {
  return buildCookieHeader(cookies);
}

/** Build a session from env vars (SAINSBURYS_COOKIE / SAINSBURYS_WCAUTHTOKEN). */
export function sessionFromEnv(): Session | null {
  const cookieHeader = process.env.SAINSBURYS_COOKIE;
  const accessToken = process.env.SAINSBURYS_ACCESS_TOKEN;
  const refreshToken = process.env.SAINSBURYS_REFRESH_TOKEN;
  if (!cookieHeader && !accessToken && !refreshToken) return null;
  const cookies = cookieHeader ? parseCookieHeader(cookieHeader) : [];
  return {
    cookies,
    wcauthtoken: process.env.SAINSBURYS_WCAUTHTOKEN ?? findWcauthtoken(cookies),
    accessToken: accessToken || undefined,
    refreshToken: refreshToken || undefined,
    source: "env",
  };
}

/** Resolve the active session: env vars take precedence over the saved file. */
export function resolveSession(sessionPath?: string): Session | null {
  return sessionFromEnv() ?? loadSession(sessionPath);
}
