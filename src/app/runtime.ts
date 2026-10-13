import fs from "node:fs";
import { GroceriesClient } from "../api/client.ts";
import { classifyBody } from "../api/classify.ts";
import { FetchTransport, type Transport } from "../api/transport.ts";
import { KoonTransport } from "../api/koon.ts";
import { PersistingTransport } from "../api/persist.ts";
import type { TraceWriter } from "../api/trace.ts";
import { readCredentials } from "../auth/credentials.ts";
import { mapLoginBundle, type MfaBundleMap } from "../auth/bundle.ts";
import { runHttpLogin, type MfaResume } from "../auth/flow.ts";
import { transportAsRaw } from "../auth/http.ts";
import type { OtpSource } from "../auth/otp.ts";
import { refreshSession } from "../auth/refresh.ts";
import { BASE_URL, statePaths } from "../config.ts";
import { isSessionExpired, SainsburysError } from "../errors.ts";
import {
  assertPreviewMatches,
  confirmBody,
  loadCheckoutMap,
  loadPreview,
  savePreview,
} from "../checkout/confirm.ts";
import { canonicalPreview, previewToken } from "../checkout/preview.ts";
import { assertNotFlagged, writeAccountFlag } from "../session/flag.ts";
import { withFileLock } from "../session/lock.ts";
import type { Redactor } from "../session/redact.ts";
import { deleteSession, resolveSession, saveSession } from "../session/store.ts";
import type { Session } from "../types.ts";
import { smartAdd } from "../services/basket.ts";
import { findInOrders, getOrderDetailFull, getOrders } from "../services/orders.ts";

export interface App {
  sessionPath: string;
  paths: ReturnType<typeof statePaths>;
  trace?: TraceWriter;
  redactor: Redactor;
  allowSignIn: boolean;
  transportFor?: (session: Session | null) => Transport;
  /** Plain fetch, used only by `doctor akamai` so it can be told apart from impersonation. */
  plainTransportFor?: (session: Session | null) => Transport;
  otp: OtpSource;
  now: () => Date;
}

export function createApp(opts: {
  sessionPath: string;
  redactor: Redactor;
  trace?: TraceWriter;
  allowSignIn?: boolean;
  transportFor?: (session: Session | null) => Transport;
  plainTransportFor?: (session: Session | null) => Transport;
  otp?: OtpSource;
  now?: () => Date;
}): App {
  return {
    sessionPath: opts.sessionPath,
    paths: statePaths(opts.sessionPath),
    trace: opts.trace,
    redactor: opts.redactor,
    allowSignIn: opts.allowSignIn ?? false,
    transportFor: opts.transportFor,
    plainTransportFor: opts.plainTransportFor,
    otp: opts.otp ?? { async take() { return null; } },
    now: opts.now ?? (() => new Date()),
  };
}

export async function login(app: App): Promise<{ action: "reused" | "refreshed" | "signed-in" | "mfa"; detail: unknown }> {
  return withFileLock(app.paths.lockPath, async () => {
    assertNotFlagged(app.paths.flagPath);
    const existing = resolveSession(app.sessionPath);
    if (existing && existing.established !== false) {
      try {
        const profile = await profileOf(app, existing);
        return { action: "reused", detail: profile };
      } catch (err) {
        rethrowUnlessExpired(err);
      }
      const refreshed = await tryRefresh(app, existing);
      if (refreshed) {
        try {
          const profile = await profileOf(app, refreshed);
          return { action: "refreshed", detail: profile };
        } catch (err) {
          rethrowUnlessExpired(err);
        }
      }
    }
    const resume = readResume(app.paths.mfaResumePath);
    if (!app.allowSignIn && !resume) throw new SainsburysError("session_expired", "No usable session, and sign-in was not requested.");
    return performLogin(app, resume);
  });
}

export async function submitOtp(app: App, code: string): Promise<{ action: "signed-in"; detail: unknown }> {
  return withFileLock(app.paths.lockPath, async () => {
    assertNotFlagged(app.paths.flagPath);
    const resume = readResume(app.paths.mfaResumePath);
    if (!resume) {
      throw new SainsburysError("needs_human", "No MFA resume file. Start `login` first; do not submit a code on its own.");
    }
    const previous = app.otp;
    app.otp = { async take() { return code.trim() || null; } };
    try {
      const result = await performLogin(app, resume);
      if (result.action !== "signed-in") {
        throw new SainsburysError("needs_human", "MFA is still required.");
      }
      return { action: "signed-in", detail: result.detail };
    } finally {
      app.otp = previous;
    }
  });
}

export async function whoami(app: App): Promise<Record<string, unknown>> {
  return withAuthed(app, async (client) => client.getProfile());
}

export async function search(app: App, query: string, limit: number): Promise<unknown> {
  assertNotFlagged(app.paths.flagPath);
  const session = resolveSession(app.sessionPath);
  const client = clientFor(app, session);
  return client.searchProducts(query, 1, limit);
}

export async function basketView(app: App): Promise<unknown> {
  return withAuthed(app, async (client) => client.getBasket(await client.hasBookedSlot()));
}

export async function basketAdd(app: App, product: string, quantity: number): Promise<unknown> {
  return withAuthed(app, async (client) => smartAdd(client, product, quantity));
}

export async function basketRemove(app: App, itemUid: string): Promise<unknown> {
  return withAuthed(app, async (client) => client.removeBasketItem(itemUid, await client.hasBookedSlot()));
}

export async function slotsView(app: App): Promise<unknown> {
  return withAuthed(app, async (client) => {
    const reservation = await client.getReservation();
    const slots = await client.listSlotsDirect({});
    if (!Array.isArray(slots) && (typeof slots !== "object" || slots === null || !Array.isArray((slots as { slots?: unknown }).slots))) {
      throw new SainsburysError("site_changed", "Slot list was not an array or {slots: array}. No slot was booked.");
    }
    return { reservation, slots };
  });
}

export async function ordersView(app: App, orderId?: string): Promise<unknown> {
  return withAuthed(app, async (client) => {
    if (orderId && orderId !== "latest") return getOrderDetailFull(client, orderId);
    const page = await getOrders(client, { pageSize: orderId === "latest" ? 1 : 10 });
    if (orderId === "latest") {
      const latest = page.orders[0];
      if (!latest) throw new SainsburysError("site_changed", "No orders were returned for this account.");
      return getOrderDetailFull(client, latest.id);
    }
    return page;
  });
}

export async function slotsBook(app: App, slotId: string): Promise<unknown> {
  return withAuthed(app, async (client) => client.bookSlotDirect(slotId));
}

export async function slotsCancel(app: App): Promise<unknown> {
  return withAuthed(app, async (client) => client.cancelReservation());
}

export async function ordersFind(app: App, query: string, pages: number): Promise<unknown> {
  return withAuthed(app, async (client) => findInOrders(client, query, { maxPages: pages }));
}

export async function checkoutPreview(app: App): Promise<{ token: string; preview: unknown }> {
  return withAuthed(app, async (client) => {
    const basket = await client.getBasket(await client.hasBookedSlot());
    const reservation = await client.getReservation();
    const payload = canonicalPreview(basket, reservation);
    const token = previewToken(payload);
    savePreview(app.paths.previewPath, { token, payload, savedAt: app.now().toISOString() });
    return { token, preview: payload };
  });
}

export async function checkoutConfirm(app: App, token: string): Promise<unknown> {
  return withAuthed(app, async (client) => {
    const basket = await client.getBasket(await client.hasBookedSlot());
    const reservation = await client.getReservation();
    const stored = loadPreview(app.paths.previewPath);
    assertPreviewMatches(token, basket, reservation, stored);
    const endpoint = loadCheckoutMap(app.paths.apiMapPath);
    if (!endpoint) {
      throw new SainsburysError(
        "checkout_unmapped",
        "Checkout confirm is a stub. No confirm endpoint is mapped. Import a sanitised HAR with scripts/import-har.ts. Nothing was posted.",
      );
    }
    const body = confirmBody(endpoint, basket, reservation, token);
    const target = endpoint.path.startsWith("http")
      ? endpoint.path
      : endpoint.path.startsWith("/groceries-api/")
        ? `${BASE_URL}${endpoint.path}`
        : endpoint.path;
    return client.request("POST", target, { body });
  });
}

export async function refresh(app: App): Promise<{ refreshed: boolean }> {
  return withFileLock(app.paths.lockPath, async () => {
    assertNotFlagged(app.paths.flagPath);
    const session = resolveSession(app.sessionPath);
    if (!session) throw new SainsburysError("session_expired", "No session to refresh.");
    const next = await tryRefresh(app, session);
    if (!next) return { refreshed: false };
    try {
      await profileOf(app, next);
      return { refreshed: true };
    } catch (err) {
      if (isSessionExpired(err)) return { refreshed: false };
      throw err;
    }
  });
}

export async function doctorApi(app: App): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    assertNotFlagged(app.paths.flagPath);
    checks.push({ name: "account-flag", ok: true, detail: "not flagged" });
  } catch (err) {
    return { ok: false, checks: [{ name: "account-flag", ok: false, detail: (err as Error).message }] };
  }
  const session = resolveSession(app.sessionPath);
  if (!session) return { ok: false, checks: [...checks, { name: "session-present", ok: false, detail: "no session" }] };
  checks.push({ name: "session-present", ok: true, detail: session.source });
  const client = clientFor(app, session);
  for (const [name, fn] of [
    ["profile", () => client.getProfile()],
    ["reservation", () => client.getReservation()],
    ["basket", () => client.getBasket()],
  ] as const) {
    try {
      await fn();
      checks.push({ name, ok: true, detail: "ok" });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof SainsburysError ? err.code : String(err).slice(0, 160) });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export async function doctorAkamai(app: App): Promise<{
  plain: string;
  impersonated: string;
  detail: { plain: string; impersonated: string };
}> {
  assertNotFlagged(app.paths.flagPath);
  const session = resolveSession(app.sessionPath);
  const url = "https://www.sainsburys.co.uk/groceries-api/gol-services/customer/v1/customer/profile";
  const plainTransport = app.plainTransportFor ? app.plainTransportFor(session) : new FetchTransport(session);
  const plain = await classifyTransport(plainTransport, url);
  let impersonated: string;
  try {
    const koon = app.transportFor ? app.transportFor(session) : new KoonTransport(session);
    impersonated = await classifyTransport(koon, url);
  } catch (err) {
    impersonated = `unavailable: ${(err as Error).message}`;
  }
  return { plain, impersonated, detail: { plain, impersonated } };
}

async function classifyTransport(transport: Transport, url: string): Promise<string> {
  try {
    const res = await transport.request("GET", url, {});
    return `${classifyBody(res.status, res.text, url)} HTTP ${res.status}`;
  } catch (err) {
    return `error ${(err as Error).message}`;
  } finally {
    await transport.close();
  }
}

async function withAuthed<T>(app: App, fn: (client: GroceriesClient, session: Session) => Promise<T>): Promise<T> {
  return withFileLock(app.paths.lockPath, async () => {
    assertNotFlagged(app.paths.flagPath);
    let session = resolveSession(app.sessionPath);
    if (session && session.established !== false) {
      try {
        await profileOf(app, session);
        return fn(clientFor(app, session), session);
      } catch (err) {
        rethrowUnlessExpired(err);
      }
      const refreshed = await tryRefresh(app, session);
      if (refreshed) {
        try {
          await profileOf(app, refreshed);
          return fn(clientFor(app, refreshed), refreshed);
        } catch (err) {
          rethrowUnlessExpired(err);
        }
      }
    }
    if (app.allowSignIn && readCredentials()) {
      const signed = await performLogin(app, readResume(app.paths.mfaResumePath));
      if (signed.action === "mfa") {
        throw new SainsburysError(
          "needs_human",
          "Sign-in reached MFA. Write the one-time code with `login --mfa-file` or the submit_otp tool. The password was not stored.",
        );
      }
      session = resolveSession(app.sessionPath);
      if (!session) throw new SainsburysError("session_expired", "Sign-in did not produce a session.");
      return fn(clientFor(app, session), session);
    }
    throw new SainsburysError(
      "session_expired",
      "Session is missing or expired. Refresh did not extend it. Set SAINSBURYS_EMAIL and SAINSBURYS_PASSWORD and run login.",
    );
  });
}

async function performLogin(app: App, resume: MfaResume | null): Promise<{ action: "signed-in" | "mfa"; detail: unknown }> {
  const creds = readCredentials();
  if (!resume && !creds) {
    throw new SainsburysError(
      "session_expired",
      "Set SAINSBURYS_EMAIL and SAINSBURYS_PASSWORD in the environment. They are not read from disk.",
    );
  }
  const session = resume
    ? { cookies: resume.cookies, wcauthtoken: "", source: "http-login" as const }
    : { cookies: [], wcauthtoken: "", source: "http-login" as const };
  const http = transportAsRaw(makeTransport(app, session, false));
  try {
    const outcome = await runHttpLogin({
      http,
      email: creds?.email ?? "",
      password: creds?.password ?? "",
      otp: app.otp,
      redactor: app.redactor,
      trace: (event) => app.trace?.log(event),
      now: app.now,
      bundle: readBundle(app.paths.mfaMapPath),
      resume,
    });
    if (outcome.kind === "mfa") {
      fs.mkdirSync(app.paths.home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(app.paths.mfaResumePath, JSON.stringify(outcome.resume, null, 2), { mode: 0o600 });
      throw new SainsburysError(
        "needs_human",
        `MFA_REQUIRED. One-time code needed for the login already in progress. Re-run \`login --mfa <code>\` or \`login --mfa-file <path>\` (or MCP submit_otp). Resume file: ${app.paths.mfaResumePath}. Password was not stored.`,
      );
    }
    saveSession(outcome.session, app.sessionPath);
    clearResume(app.paths.mfaResumePath);
    let profile: Record<string, unknown>;
    try {
      profile = await profileOf(app, outcome.session);
    } catch (err) {
      if (isSessionExpired(err)) {
        outcome.session.established = false;
        saveSession(outcome.session, app.sessionPath);
        throw new SainsburysError(
          "site_changed",
          "Login stored tokens but profile is still a guest (user_id <= 0). The session was not marked established. How the token exchange sets WC_AUTHENTICATION is not verified.",
        );
      }
      throw err;
    }
    return {
      action: "signed-in",
      detail: { profile, deviceTrustCookieNames: outcome.deviceTrustCookieNames, warning: outcome.warning },
    };
  } catch (err) {
    if (err instanceof SainsburysError && err.code === "account_flagged") {
      writeAccountFlag(app.paths.flagPath, err.message, app.now().toISOString());
    }
    throw err;
  }
}

async function tryRefresh(app: App, session: Session): Promise<Session | null> {
  const http = transportAsRaw(makeTransport(app, session, false));
  const next = await refreshSession({
    http,
    session,
    redactor: app.redactor,
    trace: (event) => app.trace?.log(event),
    now: app.now,
  });
  if (!next) return null;
  saveSession(next, app.sessionPath);
  return next;
}

async function profileOf(app: App, session: Session): Promise<Record<string, unknown>> {
  const client = clientFor(app, session);
  const profile = await client.getProfile();
  session.established = true;
  session.lastValidatedAt = app.now().toISOString();
  saveSession(session, app.sessionPath);
  return profile;
}

function clientFor(app: App, session: Session | null): GroceriesClient {
  return new GroceriesClient({ session, transport: makeTransport(app, session, true) });
}

function makeTransport(app: App, session: Session | null, persist: boolean): Transport {
  const inner = app.transportFor ? app.transportFor(session) : new KoonTransport(session);
  if (!persist || !session) return inner;
  return new PersistingTransport(inner, session, app.sessionPath);
}

function readResume(file: string): MfaResume | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MfaResume;
    if (!parsed.loginChallenge || !parsed.codeVerifier) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearResume(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // nothing to clear
  }
}

function readBundle(file: string): MfaBundleMap | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.trim().startsWith("{")) return JSON.parse(raw) as MfaBundleMap;
    return mapLoginBundle(raw);
  } catch {
    return null;
  }
}

function rethrowUnlessExpired(err: unknown): void {
  if (err instanceof SainsburysError && err.code === "account_flagged") {
    throw err;
  }
  if (err instanceof SainsburysError && err.code === "akamai_blocked") throw err;
  if (err instanceof SainsburysError && err.code === "needs_human") throw err;
  if (!isSessionExpired(err)) throw err;
}

export function forgetSession(sessionPath: string): boolean {
  return deleteSession(sessionPath);
}
