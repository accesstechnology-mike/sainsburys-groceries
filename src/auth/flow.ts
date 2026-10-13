import { classifyBody, errorForClass } from "../api/classify.ts";
import { isAkamaiBlock, SainsburysError } from "../errors.ts";
import { applySetCookies, cookieHeaderForUrl, findWcauthtoken } from "../session/cookies.ts";
import type { Redactor } from "../session/redact.ts";
import type { Session, SessionCookie } from "../types.ts";
import type { MfaBundleMap } from "./bundle.ts";
import { ACCOUNT_ORIGIN, authorizeUrl, credentialLoginUrl, REDIRECT_URI, tokenUrl } from "./endpoints.ts";
import { codeFieldName, parseForm, rememberField } from "./form.ts";
import { header, locationOf, type RawHttp, type RawResponse } from "./http.ts";
import type { OtpSource } from "./otp.ts";
import { createPkce, type Pkce } from "./pkce.ts";

export interface MfaResume {
  loginChallenge: string;
  mfaUrl: string;
  formAction?: string;
  codeField?: string;
  remember?: { name: string; value: string };
  hidden: { name: string; value: string }[];
  cookies: SessionCookie[];
  codeVerifier: string;
  state: string;
  nonce: string;
  createdAt: string;
}

export interface LoginSuccess {
  kind: "session";
  session: Session;
  deviceTrustCookieNames: string[];
  warning?: string;
}

export interface MfaPause {
  kind: "mfa";
  resume: MfaResume;
}

export type LoginOutcome = LoginSuccess | MfaPause;

const MAX_HOPS = 15;

export async function runHttpLogin(opts: {
  http: RawHttp;
  email: string;
  password: string;
  otp: OtpSource;
  redactor: Redactor;
  trace?: (event: Record<string, unknown>) => void;
  now?: () => Date;
  bundle?: MfaBundleMap | null;
  resume?: MfaResume | null;
}): Promise<LoginOutcome> {
  opts.redactor.add(opts.password);
  opts.redactor.add(opts.email);
  const now = opts.now ?? (() => new Date());
  const cookies: SessionCookie[] = opts.resume?.cookies ? opts.resume.cookies.map((cookie) => ({ ...cookie })) : [];

  const send = async (method: string, url: string, body?: string, contentType?: string): Promise<RawResponse> => {
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    const cookie = cookieHeaderForUrl(cookies, url);
    if (cookie) headers.cookie = cookie;
    const response = await opts.http.request(method, url, { body, headers });
    const next = applySetCookies(cookies, response.setCookies, url, now().getTime());
    cookies.splice(0, cookies.length, ...next);
    opts.trace?.({
      kind: "auth",
      method,
      url,
      status: response.status,
      location: header(response, "location") ?? "",
      body: body ?? "",
      responseBody: response.body.slice(0, 2000),
      setCookieNames: response.setCookies.map(cookieName),
    });
    const blocked = errorForClass(classifyBody(response.status, response.body, url), response.status, url, response.body);
    if (blocked?.code === "akamai_blocked" || blocked?.code === "account_flagged") throw blocked;
    if (isAkamaiBlock(response.status, response.body)) {
      throw new SainsburysError("akamai_blocked", `Akamai blocked ${method} ${new URL(url).pathname}`);
    }
    return response;
  };

  if (opts.resume) {
    opts.redactor.add(opts.resume.codeVerifier);
    opts.redactor.add(opts.resume.loginChallenge);
    return finishMfa(opts, opts.resume, cookies, send, now);
  }

  const pkce = createPkce();
  opts.redactor.add(pkce.verifier);
  opts.redactor.add(pkce.state);
  let url = authorizeUrl({ state: pkce.state, nonce: pkce.nonce, codeChallenge: pkce.challenge });
  let loginChallenge = "";

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const response = await send("GET", url);
    const location = locationOf(response, url);
    loginChallenge = challengeFrom(url) || (location ? challengeFrom(location) : "") || loginChallenge;
    if (location && isRedirect(response.status)) {
      if (isMfaLocation(location)) {
        return pauseOrSubmit(opts, pkce, loginChallenge, location, cookies, send, now);
      }
      if (codeFrom(location) && sameRedirect(location)) {
        return exchangeCode(opts, pkce, codeFrom(location)!, location, cookies, send, now);
      }
      url = location;
      continue;
    }
    break;
  }

  if (!loginChallenge) {
    throw new SainsburysError(
      "site_changed",
      "GET /oauth2/auth did not redirect to /login-init with login_challenge. The authorize response shape changed.",
    );
  }

  const body = new URLSearchParams({
    username: opts.email,
    password: opts.password,
    login_challenge: loginChallenge,
    ioBlackBox: "",
  }).toString();
  const posted = await send("POST", credentialLoginUrl(), body, "application/x-www-form-urlencoded");
  const location = locationOf(posted, credentialLoginUrl());
  if (!location || !isRedirect(posted.status)) {
    if (classifyBody(posted.status, posted.body) === "needs_human" || /captcha/i.test(posted.body)) {
      throw new SainsburysError("needs_human", "Credential POST was challenged before MFA. No further attempt was made.");
    }
    throw new SainsburysError(
      "site_changed",
      `POST /gol/login returned HTTP ${posted.status} without a redirect. Expected 303 to /gol/login/mfa.`,
    );
  }
  if (isMfaLocation(location) || /\/login\/mfa/i.test(location)) {
    return pauseOrSubmit(opts, pkce, loginChallenge || challengeFrom(location), location, cookies, send, now);
  }
  if (codeFrom(location)) {
    return exchangeCode(opts, pkce, codeFrom(location)!, location, cookies, send, now);
  }
  throw new SainsburysError("site_changed", `POST /gol/login redirected to an unexpected URL path.`);
}

async function pauseOrSubmit(
  opts: { otp: OtpSource; bundle?: MfaBundleMap | null; trace?: (event: Record<string, unknown>) => void },
  pkce: Pkce,
  loginChallenge: string,
  mfaUrl: string,
  cookies: SessionCookie[],
  send: (method: string, url: string, body?: string, contentType?: string) => Promise<RawResponse>,
  now: () => Date,
): Promise<LoginOutcome> {
  const page = await send("GET", mfaUrl);
  const form = parseForm(page.body, mfaUrl);
  const resume: MfaResume = {
    loginChallenge,
    mfaUrl,
    formAction: form?.action,
    codeField: form ? codeFieldName(form) ?? undefined : undefined,
    remember: form ? rememberField(form) ?? undefined : undefined,
    hidden: form
      ? form.fields
          .filter((field) => field.type === "hidden")
          .map((field) => ({ name: field.name, value: field.value }))
      : [],
    cookies: cookies.map((cookie) => ({ ...cookie })),
    codeVerifier: pkce.verifier,
    state: pkce.state,
    nonce: pkce.nonce,
    createdAt: now().toISOString(),
  };
  if (!resume.formAction && opts.bundle?.verifyPath) {
    resume.formAction = new URL(opts.bundle.verifyPath, ACCOUNT_ORIGIN).toString();
    resume.codeField = resume.codeField ?? "code";
  }
  if (opts.bundle?.rememberField && !resume.remember) {
    resume.remember = { name: opts.bundle.rememberField, value: "true" };
  }

  if (opts.bundle?.sendOtpPath) {
    const sendUrl = new URL(opts.bundle.sendOtpPath, ACCOUNT_ORIGIN).toString();
    await send(
      "POST",
      sendUrl,
      new URLSearchParams({ login_challenge: loginChallenge, ioBlackBox: "" }).toString(),
      "application/x-www-form-urlencoded",
    );
  }

  const code = await opts.otp.take();
  if (!code) {
    resume.cookies = cookies.map((cookie) => ({ ...cookie }));
    return { kind: "mfa", resume };
  }
  opts.trace?.({ kind: "auth", event: "otp-received", length: code.length });
  return submitOtp(opts, resume, code, cookies, send, now);
}

async function finishMfa(
  opts: { otp: OtpSource; trace?: (event: Record<string, unknown>) => void; redactor: Redactor },
  resume: MfaResume,
  cookies: SessionCookie[],
  send: (method: string, url: string, body?: string, contentType?: string) => Promise<RawResponse>,
  now: () => Date,
): Promise<LoginOutcome> {
  const code = await opts.otp.take();
  if (!code) return { kind: "mfa", resume };
  return submitOtp(opts, resume, code, cookies, send, now);
}

async function submitOtp(
  opts: { trace?: (event: Record<string, unknown>) => void; redactor?: Redactor },
  resume: MfaResume,
  code: string,
  cookies: SessionCookie[],
  send: (method: string, url: string, body?: string, contentType?: string) => Promise<RawResponse>,
  now: () => Date,
): Promise<LoginSuccess> {
  opts.redactor?.add(code);
  if (!resume.formAction || !resume.codeField) {
    throw new SainsburysError(
      "site_changed",
      "MFA page had no parseable form and no bundle map verify path. Save the login-ui JS bundle and run scripts/map-login-js.ts. The code was not submitted.",
    );
  }
  const params = new URLSearchParams();
  for (const field of resume.hidden) {
    if (field.name.toLowerCase() !== "password") params.set(field.name, field.value);
  }
  if (!params.has("login_challenge") && resume.loginChallenge) params.set("login_challenge", resume.loginChallenge);
  if (!params.has("ioBlackBox")) params.set("ioBlackBox", "");
  params.set(resume.codeField, code);
  if (resume.remember) params.set(resume.remember.name, resume.remember.value);
  let current = await send("POST", resume.formAction, params.toString(), "application/x-www-form-urlencoded");
  let location = locationOf(current, resume.formAction);
  for (let guard = 0; location && isRedirect(current.status) && guard < 8; guard++) {
    if (codeFrom(location)) break;
    current = await send("GET", location);
    const next = locationOf(current, location);
    location = next;
    if (!next || !isRedirect(current.status) || codeFrom(next)) break;
  }
  const codeValue = location ? codeFrom(location) : null;
  if (!codeValue) {
    throw new SainsburysError(
      "site_changed",
      "MFA submit did not redirect to the groceries OAuth redirect with an authorization code.",
    );
  }
  if (stateFrom(location!) && stateFrom(location!) !== resume.state) {
    throw new SainsburysError("site_changed", "OAuth state did not match the login that started this MFA step.");
  }
  const pkce: Pkce = {
    verifier: resume.codeVerifier,
    challenge: "",
    state: resume.state,
    nonce: resume.nonce,
  };
  return exchangeCode(
    { trace: opts.trace, redactor: opts.redactor },
    pkce,
    codeValue,
    location!,
    cookies,
    send,
    now,
  );
}

async function exchangeCode(
  opts: { trace?: (event: Record<string, unknown>) => void; redactor?: Redactor },
  pkce: Pkce,
  code: string,
  redirectLocation: string,
  cookies: SessionCookie[],
  send: (method: string, url: string, body?: string, contentType?: string) => Promise<RawResponse>,
  now: () => Date,
): Promise<LoginSuccess> {
  opts.redactor?.add(code);
  opts.redactor?.add(pkce.verifier);
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: "gol",
    code_verifier: pkce.verifier,
  }).toString();
  const token = await send("POST", tokenUrl(), tokenBody, "application/x-www-form-urlencoded");
  let accessToken = "";
  let refreshToken = "";
  let idToken = "";
  let tokenType = "";
  let expiresAt: string | undefined;
  if (token.status < 400 && token.body.trim().startsWith("{")) {
    const parsed = JSON.parse(token.body) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    accessToken = parsed.access_token ?? "";
    refreshToken = parsed.refresh_token ?? "";
    idToken = parsed.id_token ?? "";
    tokenType = parsed.token_type ?? "";
    if (parsed.expires_in) expiresAt = new Date(now().getTime() + parsed.expires_in * 1000).toISOString();
    opts.redactor?.add(accessToken);
    opts.redactor?.add(refreshToken);
    opts.redactor?.add(idToken);
  }
  // The browser lands on the redirect URI after Hydra. GET it for WC_* cookies.
  // Whether this consumes the code is unverified; the token POST above is the
  // refresh_token source. A guest profile afterwards is a loud failure.
  if (sameRedirect(redirectLocation)) await send("GET", redirectLocation);

  const wc = findWcauthtoken(cookies);
  const session: Session = {
    cookies: cookies.map((cookie) => ({ ...cookie })),
    wcauthtoken: wc,
    accessToken: accessToken || undefined,
    refreshToken: refreshToken || undefined,
    idToken: idToken || undefined,
    tokenType: tokenType || undefined,
    expiresAt,
    lastLogin: now().toISOString(),
    source: "http-login",
    established: Boolean(wc),
  };
  const deviceTrustCookieNames = cookies
    .map((cookie) => cookie.name)
    .filter((name) => /remember|device[-_]?trust|trust[-_]?device/i.test(name));
  if (!wc && !accessToken && !refreshToken) {
    throw new SainsburysError(
      "site_changed",
      "Login finished without WC_AUTHENTICATION, access_token, or refresh_token. Token-to-cookie exchange is unverified and this response did not contain them.",
    );
  }
  let warning: string | undefined;
  if (!wc) {
    warning =
      "refresh/access tokens were stored but WC_AUTHENTICATION was not set. Profile must be checked before this session is reused. That exchange is not verified live.";
    session.established = false;
  }
  return { kind: "session", session, deviceTrustCookieNames, warning };
}

export function deviceTrustNames(cookies: SessionCookie[]): string[] {
  return cookies.map((cookie) => cookie.name).filter((name) => /remember|device[-_]?trust|trust[-_]?device/i.test(name));
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isMfaLocation(url: string): boolean {
  try {
    return /\/login\/mfa/i.test(new URL(url).pathname);
  } catch {
    return /\/login\/mfa/i.test(url);
  }
}

function challengeFrom(url: string): string {
  try {
    return new URL(url).searchParams.get("login_challenge") ?? "";
  } catch {
    return "";
  }
}

function codeFrom(url: string): string | null {
  try {
    return new URL(url).searchParams.get("code");
  } catch {
    return null;
  }
}

function stateFrom(url: string): string | null {
  try {
    return new URL(url).searchParams.get("state");
  } catch {
    return null;
  }
}

function sameRedirect(url: string): boolean {
  try {
    const target = new URL(url);
    const expected = new URL(REDIRECT_URI);
    return target.origin === expected.origin && target.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function cookieName(line: string): string {
  return line.split("=", 1)[0] ?? "";
}
