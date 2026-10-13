import {
  ApiError,
  isAccountFlag,
  isAkamaiBlock,
  isBotChallenge,
  isMfaChallenge,
  isPaymentChallenge,
  SainsburysError,
} from "../errors.ts";

export type HttpClass = "ok" | "akamai_blocked" | "session_expired" | "needs_human" | "account_flagged" | "payment_challenge" | "site_changed";

/**
 * Tell an Akamai edge block apart from a dead login.
 * Guest profile JSON (user_id <= 0) is auth expiry, not a WAF block.
 */
export function classifyBody(status: number, body: string, url = ""): HttpClass {
  if (isPaymentChallenge(body)) return "payment_challenge";
  if (isAccountFlag(body)) return "account_flagged";
  if (isAkamaiBlock(status, body)) return "akamai_blocked";
  if (isBotChallenge(body) || isMfaChallenge(body)) return "needs_human";
  if (status === 401) return "session_expired";
  if (isProfileUrl(url) && isGuestProfile(body)) return "session_expired";
  if (status >= 400) return "site_changed";
  if (/<!doctype html|<html/i.test(body.slice(0, 300)) && !url.includes("/login")) return "site_changed";
  return "ok";
}

export function isProfileUrl(url: string): boolean {
  return url.includes("/customer/v1/customer/profile");
}

export function isGuestProfile(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { user_id?: unknown };
    const userId = Number(parsed?.user_id ?? 0);
    return !Number.isFinite(userId) || userId <= 0;
  } catch {
    return false;
  }
}

export function errorForClass(kind: HttpClass, status: number, url: string, body: string): SainsburysError | null {
  if (kind === "ok") return null;
  if (kind === "session_expired") {
    return new ApiError(status, url, "session is missing or is a guest profile", body.slice(0, 500), "session_expired");
  }
  if (kind === "akamai_blocked") {
    return new ApiError(status, url, "Akamai blocked this HTTP client", body.slice(0, 500), "akamai_blocked");
  }
  if (kind === "needs_human") {
    return new SainsburysError(
      "needs_human",
      "Sainsbury's returned a bot check, captcha, or one-time code. Automation stopped; a person has to finish that step.",
    );
  }
  if (kind === "account_flagged") {
    return new SainsburysError(
      "account_flagged",
      "Sainsbury's indicated the account is suspended or locked. Automation stopped.",
    );
  }
  if (kind === "payment_challenge") {
    return new SainsburysError(
      "payment_challenge",
      "Sainsbury's asked for CVV or 3-D Secure. This client never enters card data.",
    );
  }
  return new ApiError(status, url, "unexpected response", body.slice(0, 500), "site_changed");
}

export function classifyResponse(status: number, url: string, body: string): SainsburysError | null {
  return errorForClass(classifyBody(status, body, url), status, url, body);
}
