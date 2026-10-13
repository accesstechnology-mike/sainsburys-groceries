import { applySetCookies, cookieHeaderForUrl, findWcauthtoken } from "../session/cookies.ts";
import type { Redactor } from "../session/redact.ts";
import type { Session, SessionCookie } from "../types.ts";
import { authorizeUrl, CLIENT_ID, SILENT_REFRESH_URL, tokenUrl } from "./endpoints.ts";
import { header, locationOf, type RawHttp, type RawResponse } from "./http.ts";
import { createPkce } from "./pkce.ts";
import { SainsburysError, isAkamaiBlock } from "../errors.ts";

/**
 * Refresh is unverified live: MFA blocked the first authenticated session.
 * Order: refresh_token grant (scope includes offline), then
 * GET /gol-ui/oauth/refresh which the SPA uses for prompt=none.
 * A password is never posted from here.
 */
export async function refreshSession(opts: {
  http: RawHttp;
  session: Session;
  redactor: Redactor;
  trace?: (event: Record<string, unknown>) => void;
  now?: () => Date;
}): Promise<Session | null> {
  const now = opts.now ?? (() => new Date());
  const cookies: SessionCookie[] = opts.session.cookies.map((cookie) => ({ ...cookie }));
  let changed = false;
  const session: Session = { ...opts.session, cookies };

  const send = async (method: string, url: string, body?: string, contentType?: string): Promise<RawResponse> => {
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    const cookie = cookieHeaderForUrl(cookies, url);
    if (cookie) headers.cookie = cookie;
    if (session.wcauthtoken) headers.wcauthtoken = session.wcauthtoken;
    if (session.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
    const response = await opts.http.request(method, url, { body, headers });
    if (response.setCookies.length) {
      const next = applySetCookies(cookies, response.setCookies, url, now().getTime());
      cookies.splice(0, cookies.length, ...next);
      changed = true;
    }
    opts.trace?.({
      kind: "refresh",
      method,
      url,
      status: response.status,
      location: header(response, "location") ?? "",
      body: body ?? "",
      responseBody: response.body.slice(0, 1500),
    });
    if (isAkamaiBlock(response.status, response.body)) {
      throw new SainsburysError("akamai_blocked", "Akamai blocked the refresh request.");
    }
    return response;
  };

  if (session.refreshToken) {
    opts.redactor.add(session.refreshToken);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: CLIENT_ID,
    }).toString();
    const token = await send("POST", tokenUrl(), body, "application/x-www-form-urlencoded");
    if (token.status < 400 && token.body.trim().startsWith("{")) {
      const parsed = JSON.parse(token.body) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
      };
      if (parsed.access_token) {
        session.accessToken = parsed.access_token;
        opts.redactor.add(parsed.access_token);
        changed = true;
      }
      if (parsed.refresh_token) {
        session.refreshToken = parsed.refresh_token;
        opts.redactor.add(parsed.refresh_token);
        changed = true;
      }
      if (parsed.expires_in) session.expiresAt = new Date(now().getTime() + parsed.expires_in * 1000).toISOString();
      if (parsed.token_type) session.tokenType = parsed.token_type;
    }
  }

  const wcBefore = findWcauthtoken(cookies);
  await trySilent(send, session);
  const wc = findWcauthtoken(cookies);
  if (wc && wc !== wcBefore) {
    session.wcauthtoken = wc;
    changed = true;
  } else if (wc) {
    session.wcauthtoken = wc;
  }
  if (!changed) return null;
  session.cookies = cookies;
  session.lastRefreshAt = now().toISOString();
  session.source = "refresh";
  return session;
}

async function trySilent(
  send: (method: string, url: string, body?: string, contentType?: string) => Promise<RawResponse>,
  session: Session,
): Promise<void> {
  let url = SILENT_REFRESH_URL;
  for (let hop = 0; hop < 8; hop++) {
    const response = await send("GET", url);
    const location = locationOf(response, url);
    if (location && (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307)) {
      if (/\/gol\/login|\/login-init/i.test(location) && !location.includes("prompt=none")) return;
      url = location;
      continue;
    }
    if (response.status === 404 || response.status >= 400) return;
    break;
  }
  // If the SPA path did not itself redirect into Hydra, try prompt=none directly.
  if (!url.includes("/oauth2/auth")) {
    const pkce = createPkce();
    const silent = authorizeUrl({
      state: pkce.state,
      nonce: pkce.nonce,
      codeChallenge: pkce.challenge,
      prompt: "none",
    });
    const response = await send("GET", silent);
    const location = locationOf(response, silent);
    if (!location) return;
    if (/login\/mfa|\/gol\/login/i.test(location) && !location.includes("code=")) return;
    const code = new URL(location).searchParams.get("code");
    if (!code) return;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://www.sainsburys.co.uk/gol-ui/oauth/redirect",
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString();
    const token = await send("POST", tokenUrl(), body, "application/x-www-form-urlencoded");
    if (token.status < 400 && token.body.trim().startsWith("{")) {
      const parsed = JSON.parse(token.body) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (parsed.access_token) session.accessToken = parsed.access_token;
      if (parsed.refresh_token) session.refreshToken = parsed.refresh_token;
      if (parsed.expires_in) session.expiresAt = new Date(Date.now() + parsed.expires_in * 1000).toISOString();
    }
  }
}
