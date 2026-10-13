import { BASE_URL } from "../config.ts";

/**
 * Auth endpoints.
 *
 * Verified 13 Oct 2026 with curl_cffi chrome impersonation (no browser):
 * - GET /oauth2/auth returns 302 to /login-init?login_challenge=<hex>
 * - POST /gol/login (missionId=gol) with form username, password,
 *   login_challenge, ioBlackBox= returns 303 to /gol/login/mfa
 * - POST /login-ui/gol/login returns 405. Do not call it.
 * - LOGIN_RECAPTCHA_ENABLED=false
 *
 * From a public authorize URL (webcompat), also sent here: missionId and
 * response_mode. Not re-checked as the cause of the 302.
 *
 * Not verified (blocked on MFA, no authenticated session yet):
 * - the MFA verify/send field names inside the login-ui bundle
 * - POST /oauth2/token refresh_token and the step that sets WC_AUTHENTICATION_*
 * - GET /gol-ui/oauth/refresh as prompt=none
 */
export const ACCOUNT_ORIGIN = "https://account.sainsburys.co.uk";
export const REDIRECT_URI = `${BASE_URL}/gol-ui/oauth/redirect`;
export const SILENT_REFRESH_URL = `${BASE_URL}/gol-ui/oauth/refresh`;
export const CLIENT_ID = "gol";
export const MISSION_ID = "gol";
export const OAUTH_SCOPE = "openid offline gol-session";
export const OAUTH_AUDIENCE = "gol.sainsburys.co.uk";

export function authorizeUrl(params: {
  state: string;
  nonce: string;
  codeChallenge: string;
  prompt?: string;
}): string {
  const url = new URL("/oauth2/auth", ACCOUNT_ORIGIN);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("audience", OAUTH_AUDIENCE);
  url.searchParams.set("missionId", MISSION_ID);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("response_mode", "query");
  if (params.prompt) url.searchParams.set("prompt", params.prompt);
  return url.toString();
}

export function credentialLoginUrl(): string {
  return `${ACCOUNT_ORIGIN}/${MISSION_ID}/login`;
}

export function tokenUrl(): string {
  return `${ACCOUNT_ORIGIN}/oauth2/token`;
}
