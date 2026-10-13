/**
 * Typed failures for the headless access layer.
 * Exit codes are stable so agents can branch on the process status.
 * There is no sign-in quota: repeated sign-ins are allowed until Sainsbury's
 * itself returns a challenge or an account flag.
 */

export const ERRORS = {
  session_expired: 10,
  needs_human: 12,
  akamai_blocked: 13,
  site_changed: 14,
  account_flagged: 15,
  payment_challenge: 16,
  checkout_unmapped: 17,
  preview_mismatch: 18,
} as const;

export type ErrorCode = keyof typeof ERRORS;

export class SainsburysError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SainsburysError";
    this.code = code;
    this.exitCode = ERRORS[code];
  }
}

export class NoSessionError extends SainsburysError {
  constructor(message?: string) {
    super(
      "session_expired",
      message ??
        "No usable Sainsbury's session. Run `sainsburys login` (SAINSBURYS_EMAIL and SAINSBURYS_PASSWORD in the environment), or import cookies.",
    );
    this.name = "NoSessionError";
  }
}

export class ApiError extends SainsburysError {
  readonly status: number;
  readonly url: string;
  readonly body?: string;

  constructor(status: number, url: string, message: string, body?: string, code?: ErrorCode) {
    super(code ?? codeForHttp(status, body ?? ""), `HTTP ${status} on ${url}: ${message}`);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }

  get looksBlocked(): boolean {
    return this.code === "akamai_blocked";
  }
}

export function isSessionExpired(err: unknown): boolean {
  return err instanceof SainsburysError && err.code === "session_expired";
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof SainsburysError) return err.exitCode;
  return 1;
}

export function codeForHttp(status: number, body: string): ErrorCode {
  if (isPaymentChallenge(body)) return "payment_challenge";
  if (isAkamaiBlock(status, body)) return "akamai_blocked";
  if (isBotChallenge(body)) return "needs_human";
  if (status === 401 || status === 403) {
    if (isAkamaiBlock(status, body)) return "akamai_blocked";
    if (status === 401) return "session_expired";
  }
  if (status === 401) return "session_expired";
  return "site_changed";
}

export function isAkamaiBlock(status: number, body: string): boolean {
  if (status !== 403 && status !== 503) return false;
  return /access denied|akamai|edgesuite|reference\s*#/i.test(body.slice(0, 4000));
}

export function isBotChallenge(body: string): boolean {
  return /captcha|recaptcha|hcaptcha|cf-challenge|bot\s*manager|verify you are (a )?human|please enable javascript/i.test(
    body.slice(0, 8000),
  );
}

export function isPaymentChallenge(body: string): boolean {
  return /\b3d[\s-]?secure\b|\bcvv\b|\bcvc\b|\bpareq\b|cardinal commerce|payment authentication|challenge window/i.test(
    body.slice(0, 8000),
  );
}

export function isAccountFlag(body: string): boolean {
  return /account (has been |is )?(suspended|locked|disabled|closed|frozen)|we'?ve locked your account|account flagged/i.test(
    body.slice(0, 8000),
  );
}

export function isMfaChallenge(body: string): boolean {
  return /one[- ]time (code|password)|verification code|enter the code|authenticator|two[- ]factor|\bmfa\b|\botp\b|text message with a code|sms code/i.test(
    body.slice(0, 8000),
  );
}
