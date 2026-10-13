import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyBody } from "../src/api/classify.ts";
import type { Transport, TransportResponse } from "../src/api/transport.ts";
import { TraceWriter } from "../src/api/trace.ts";
import { mapLoginBundle } from "../src/auth/bundle.ts";
import { authorizeUrl, credentialLoginUrl } from "../src/auth/endpoints.ts";
import { runHttpLogin } from "../src/auth/flow.ts";
import type { RawHttp, RawResponse } from "../src/auth/http.ts";
import { createPkce } from "../src/auth/pkce.ts";
import { refreshSession } from "../src/auth/refresh.ts";
import { checkoutEndpoints, parseHar, sanitiseHar } from "../src/checkout/har.ts";
import { createApp, checkoutConfirm, checkoutPreview, doctorAkamai, login, search, submitOtp, whoami } from "../src/app/runtime.ts";
import { parseDuration, runProbeLoop } from "../src/app/probe.ts";
import { ERRORS } from "../src/errors.ts";
import { handleRpc, startMcpHttp } from "../src/mcp/server.ts";
import { applySetCookies, parseCookieHeader } from "../src/session/cookies.ts";
import { withFileLock } from "../src/session/lock.ts";
import { Redactor } from "../src/session/redact.ts";
import { loadSession } from "../src/session/store.ts";
import type { Session } from "../src/types.ts";

const PASSWORD = "fixture-password-value";
const EMAIL = "fixture@example.com";
const root = path.resolve(import.meta.dir, "..");
const profile = JSON.parse(fs.readFileSync(path.join(root, "fixtures/profile.json"), "utf8"));
const guest = JSON.parse(fs.readFileSync(path.join(root, "fixtures/guest-profile.json"), "utf8"));
const basket = JSON.parse(fs.readFileSync(path.join(root, "fixtures/basket.json"), "utf8"));
const reservation = JSON.parse(fs.readFileSync(path.join(root, "fixtures/reservation.json"), "utf8"));
const searchBody = JSON.parse(fs.readFileSync(path.join(root, "fixtures/search.json"), "utf8"));
const mfaHtml = fs.readFileSync(path.join(root, "fixtures/mfa-form.html"), "utf8");
const denied = fs.readFileSync(path.join(root, "fixtures/akamai-denied.html"), "utf8");
const bundleSource = fs.readFileSync(path.join(root, "fixtures/login-ui-snippet.js"), "utf8");
const harRaw = fs.readFileSync(path.join(root, "fixtures/checkout-example.har"), "utf8");

const envKeys = ["SAINSBURYS_EMAIL", "SAINSBURYS_USERNAME", "SAINSBURYS_PASSWORD", "SAINSBURYS_COOKIE", "SAINSBURYS_WCAUTHTOKEN", "SAINSBURYS_ACCESS_TOKEN", "SAINSBURYS_REFRESH_TOKEN"] as const;
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

function useCreds(): void {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  process.env.SAINSBURYS_EMAIL = EMAIL;
  process.env.SAINSBURYS_PASSWORD = PASSWORD;
  delete process.env.SAINSBURYS_USERNAME;
  delete process.env.SAINSBURYS_COOKIE;
  delete process.env.SAINSBURYS_WCAUTHTOKEN;
  delete process.env.SAINSBURYS_ACCESS_TOKEN;
  delete process.env.SAINSBURYS_REFRESH_TOKEN;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sainsburys-"));
}

function ok(
  status: number,
  text: string,
  extra: { location?: string; setCookies?: string[] } | string[] = {},
): TransportResponse {
  const bag = Array.isArray(extra) ? { setCookies: extra } : extra;
  return {
    status,
    text,
    headers: bag.location ? { location: bag.location } : {},
    setCookies: bag.setCookies ?? [],
  };
}

class Scripted implements Transport {
  readonly calls: { method: string; url: string; body?: unknown; headers?: Record<string, string> }[] = [];
  state = "";
  constructor(private handle: (call: Scripted["calls"][number], state: string) => TransportResponse) {}
  async request(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<TransportResponse> {
    if (url.includes("/oauth2/auth")) this.state = new URL(url).searchParams.get("state") ?? this.state;
    const call = { method, url, body: opts.body, headers: opts.headers };
    this.calls.push(call);
    return this.handle(call, this.state);
  }
  async close(): Promise<void> {}
}

function loginTransport(otpReady: boolean): Scripted {
  return new Scripted((call, state) => {
    const url = new URL(call.url);
    if (url.pathname === "/oauth2/auth") {
      return ok(302, "", { location: `https://account.sainsburys.co.uk/login-init?login_challenge=abc123def456` });
    }
    if (url.pathname === "/login-init") {
      return ok(302, "", { location: `https://account.sainsburys.co.uk/gol/login?login_challenge=abc123def456` });
    }
    if (url.pathname === "/gol/login" && call.method === "GET") return ok(200, "<html>login</html>");
    if (url.pathname === "/gol/login" && call.method === "POST") {
      return ok(303, "", { location: "https://account.sainsburys.co.uk/gol/login/mfa?login_challenge=abc123def456" });
    }
    if (url.pathname === "/gol/login/mfa" && call.method === "GET") return ok(200, mfaHtml);
    if (url.pathname === "/gol/login/mfa" && call.method === "POST") {
      return ok(303, "", {
        location: `https://www.sainsburys.co.uk/gol-ui/oauth/redirect?code=auth-code&state=${state}`,
        setCookies: ["remember-device=trust-value; Path=/; Domain=.sainsburys.co.uk"],
      });
    }
    if (url.pathname === "/oauth2/token") {
      return ok(200, JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "Bearer" }));
    }
    if (url.pathname === "/gol-ui/oauth/redirect") {
      return ok(200, "<html>redirect</html>", {
        setCookies: ["WC_AUTHENTICATION_42=wc-value; Path=/; Domain=.sainsburys.co.uk"],
      });
    }
    if (url.pathname.endsWith("/customer/v1/customer/profile")) return ok(200, JSON.stringify(otpReady ? profile : guest));
    if (url.pathname.includes("/product")) return ok(200, JSON.stringify(searchBody));
    if (url.pathname.includes("/basket")) return ok(200, JSON.stringify(basket));
    if (url.pathname.includes("/reservation") || url.pathname.endsWith("/slots")) return ok(200, JSON.stringify(url.pathname.endsWith("/slots") ? { slots: [] } : reservation));
    return ok(404, "{}");
  });
}

describe("live auth shape", () => {
  test("authorize URL matches the 13 Oct Hydra parameters", () => {
    const pkce = createPkce();
    const url = new URL(authorizeUrl({ state: pkce.state, nonce: pkce.nonce, codeChallenge: pkce.challenge }));
    expect(url.origin).toBe("https://account.sainsburys.co.uk");
    expect(url.pathname).toBe("/oauth2/auth");
    expect(url.searchParams.get("client_id")).toBe("gol");
    expect(url.searchParams.get("scope")).toBe("openid offline gol-session");
    expect(url.searchParams.get("audience")).toBe("gol.sainsburys.co.uk");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.sainsburys.co.uk/gol-ui/oauth/redirect");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(pkce.state.length).toBeGreaterThanOrEqual(24);
    expect(pkce.nonce.length).toBeGreaterThanOrEqual(24);
    expect(credentialLoginUrl()).toBe("https://account.sainsburys.co.uk/gol/login");
  });

  test("credential POST goes to /gol/login and MFA without a code pauses", async () => {
    const scripted = loginTransport(false);
    const http = raw(scripted);
    const redactor = new Redactor();
    const outcome = await runHttpLogin({
      http,
      email: EMAIL,
      password: PASSWORD,
      otp: { async take() { return null; } },
      redactor,
    });
    expect(outcome.kind).toBe("mfa");
    if (outcome.kind !== "mfa") return;
    const post = scripted.calls.find((call) => call.method === "POST" && call.url.includes("/gol/login") && !call.url.includes("/mfa"));
    expect(post?.url).toBe("https://account.sainsburys.co.uk/gol/login");
    expect(String(post?.body)).toContain("username=");
    expect(String(post?.body)).toContain("ioBlackBox=");
    expect(String(post?.body)).toContain(`password=${encodeURIComponent(PASSWORD)}`);
    expect(scripted.calls.some((call) => call.url.includes("/login-ui/"))).toBe(false);
    expect(JSON.stringify(outcome.resume)).not.toContain(PASSWORD);
    expect(outcome.resume.codeField).toBe("otp");
    expect(outcome.resume.remember?.name).toBe("rememberDevice");
  });

  test("OTP continues the same login and stores refresh_token plus WC cookie", async () => {
    const scripted = loginTransport(true);
    const redactor = new Redactor();
    const lines: string[] = [];
    const trace = { log(event: Record<string, unknown>) { lines.push(JSON.stringify(event)); } };
    const outcome = await runHttpLogin({
      http: raw(scripted),
      email: EMAIL,
      password: PASSWORD,
      otp: { async take() { return "123456"; } },
      redactor,
      trace: (event) => trace.log(event),
    });
    expect(outcome.kind).toBe("session");
    if (outcome.kind !== "session") return;
    expect(outcome.session.wcauthtoken).toBe("wc-value");
    expect(outcome.session.refreshToken).toBe("fixture-refresh");
    expect(outcome.deviceTrustCookieNames).toContain("remember-device");
    expect(JSON.stringify(outcome.session)).not.toContain(PASSWORD);
    const redacted = redactor.redact(lines.join("\n"));
    expect(redacted).not.toContain(PASSWORD);
    const mfaPost = scripted.calls.find((call) => call.method === "POST" && call.url.includes("/mfa"));
    expect(String(mfaPost?.body)).toContain("otp=123456");
    expect(String(mfaPost?.body)).toContain("rememberDevice=true");
    expect(String(mfaPost?.body)).not.toContain("password=");
  });

  test("403 HTML is blocked and guest JSON is unauthenticated", () => {
    expect(classifyBody(403, denied, "https://www.sainsburys.co.uk/groceries-api/gol-services/customer/v1/customer/profile")).toBe("akamai_blocked");
    expect(classifyBody(200, JSON.stringify(guest), "https://www.sainsburys.co.uk/groceries-api/gol-services/customer/v1/customer/profile")).toBe("session_expired");
    expect(classifyBody(200, JSON.stringify(profile), "https://www.sainsburys.co.uk/groceries-api/gol-services/customer/v1/customer/profile")).toBe("ok");
  });

  test("refresh_token grant updates the session without a password", async () => {
    const calls: string[] = [];
    const http: RawHttp = {
      async request(method, url, opts) {
        calls.push(`${method} ${new URL(url).pathname}`);
        if (url.includes("/oauth2/token")) {
          expect(String(opts?.body)).toContain("grant_type=refresh_token");
          expect(String(opts?.body)).not.toContain("password");
          return rawResponse(200, JSON.stringify({ access_token: "next-access", refresh_token: "next-refresh", expires_in: 1800 }), [
            "WC_AUTHENTICATION_42=refreshed-wc; Path=/; Domain=.sainsburys.co.uk",
          ]);
        }
        return rawResponse(404, "");
      },
    };
    const session: Session = {
      cookies: [{ name: "WC_AUTHENTICATION_42", value: "old", domain: ".sainsburys.co.uk", path: "/" }],
      wcauthtoken: "old",
      refreshToken: "old-refresh",
      source: "http-login",
      established: true,
    };
    const next = await refreshSession({ http, session, redactor: new Redactor() });
    expect(next?.accessToken).toBe("next-access");
    expect(next?.refreshToken).toBe("next-refresh");
    expect(next?.wcauthtoken).toBe("refreshed-wc");
    expect(calls.some((call) => call.includes("password"))).toBe(false);
  });

  test("bundle parser finds verify, send and remember hints", () => {
    const mapped = mapLoginBundle(bundleSource);
    expect(mapped.verifyPath).toBe("/gol/login/mfa/verify");
    expect(mapped.sendOtpPath).toBe("/gol/login/mfa/send");
    expect(mapped.rememberField).toBe("rememberDevice");
  });
});

describe("session and checkout", () => {
  test("there is no sign-in quota", () => {
    expect(Object.keys(ERRORS)).not.toContain("signin_quota_used");
  });

  test("__Host- cookies stay host-only", () => {
    const cookies = parseCookieHeader("__Host-authjs.csrf-token=abc; WC_AUTHENTICATION_7=wc");
    const host = cookies.find((cookie) => cookie.name.startsWith("__Host-"));
    expect(host?.domain).toBeUndefined();
    expect(host?.hostOnly).toBe(true);
    const merged = applySetCookies(
      [],
      ["__Host-authjs.csrf-token=next; Path=/; Secure"],
      "https://account.sainsburys.co.uk/gol/login",
    );
    expect(merged[0]?.domain).toBeUndefined();
    expect(merged[0]?.host).toBe("account.sainsburys.co.uk");
  });

  test("lock serialises callers", async () => {
    const dir = tempDir();
    let current = 0;
    let max = 0;
    await Promise.all(
      [0, 1, 2].map(() =>
        withFileLock(path.join(dir, "session.json.lock"), async () => {
          current++;
          max = Math.max(max, current);
          await new Promise((resolve) => setTimeout(resolve, 30));
          current--;
        }),
      ),
    );
    expect(max).toBe(1);
  });

  test("login persists WC cookie and a later whoami reuses it", async () => {
    useCreds();
    const dir = tempDir();
    const sessionPath = path.join(dir, "session.json");
    const trace = new TraceWriter(path.join(dir, "trace.jsonl"), new Redactor());
    const scripted = loginTransport(true);
    const app = createApp({
      sessionPath,
      redactor: new Redactor(),
      trace,
      allowSignIn: true,
      transportFor: () => scripted,
      otp: { async take() { return "123456"; } },
    });
    const signed = await login(app);
    expect(signed.action).toBe("signed-in");
    const saved = fs.readFileSync(sessionPath, "utf8");
    expect(saved).not.toContain(PASSWORD);
    expect(saved).toContain("wc-value");
    expect(loadSession(sessionPath)?.established).toBe(true);
    const again = await login(app);
    expect(again.action).toBe("reused");
    expect(scripted.calls.filter((call) => call.method === "POST" && call.url.endsWith("/gol/login")).length).toBe(1);
  });

  test("set-cookie on profile is written back", async () => {
    useCreds();
    const dir = tempDir();
    const sessionPath = path.join(dir, "session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        cookies: [{ name: "WC_AUTHENTICATION_42", value: "wc-value", domain: ".sainsburys.co.uk", path: "/" }],
        wcauthtoken: "wc-value",
        source: "http-login",
        established: true,
      }),
    );
    const app = createApp({
      sessionPath,
      redactor: new Redactor(),
      allowSignIn: false,
      transportFor: () =>
        new Scripted(() =>
          ok(200, JSON.stringify(profile), ["WC_USERACTIVITY_42=fresh; Path=/; Domain=.sainsburys.co.uk"]),
        ),
    });
    await whoami(app);
    expect(loadSession(sessionPath)?.cookies.some((cookie) => cookie.name === "WC_USERACTIVITY_42" && cookie.value === "fresh")).toBe(true);
  });

  test("checkout confirm is stubbed until a map exists, then posts preview values", async () => {
    const dir = tempDir();
    const sessionPath = path.join(dir, "session.json");
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({
        cookies: [{ name: "WC_AUTHENTICATION_42", value: "wc-value", domain: ".sainsburys.co.uk", path: "/" }],
        wcauthtoken: "wc-value",
        source: "http-login",
        established: true,
      }),
    );
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const app = createApp({
      sessionPath,
      redactor: new Redactor(),
      allowSignIn: false,
      transportFor: () =>
        new Scripted((call) => {
          calls.push(call);
          if (call.url.includes("/profile")) return ok(200, JSON.stringify(profile));
          if (call.url.includes("/basket")) return ok(200, JSON.stringify(basket));
          if (call.url.includes("/reservation")) return ok(200, JSON.stringify(reservation));
          if (call.url.includes("/confirm")) return ok(200, JSON.stringify({ status: "confirmed", order_uid: "order-fixture-1" }));
          return ok(404, "{}");
        }),
    });
    const preview = await checkoutPreview(app);
    await expect(checkoutConfirm(app, preview.token)).rejects.toMatchObject({ code: "checkout_unmapped" });
    const endpoints = checkoutEndpoints(parseHar(harRaw));
    expect(endpoints[0]?.bodyKeys).not.toContain("password");
    fs.writeFileSync(
      path.join(dir, "api-map.json"),
      JSON.stringify({ endpoints: [{ id: "checkout.confirm", method: "POST", path: "/groceries-api/gol-services/checkout/v1/order/confirm", bodyKeys: ["basket_id", "slot_id"] }] }),
    );
    const confirmed = (await checkoutConfirm(app, preview.token)) as { status?: string };
    expect(confirmed.status).toBe("confirmed");
    const post = calls.find((call) => call.method === "POST");
    expect(JSON.stringify(post?.body)).toContain("basket-fixture-1");
    expect(JSON.stringify(post?.body)).not.toContain("bkt-from-har");
    expect(JSON.stringify(post?.body)).not.toContain("har-password-value");
    const sanitised = sanitiseHar(harRaw);
    expect(sanitised).not.toContain("secret-cookie-value");
    expect(sanitised).not.toContain("har-password-value");
  });

  test("doctor akamai separates block from guest", async () => {
    const dir = tempDir();
    const app = createApp({
      sessionPath: path.join(dir, "session.json"),
      redactor: new Redactor(),
      allowSignIn: false,
      plainTransportFor: () => new Scripted(() => ok(403, denied)),
      transportFor: () => new Scripted(() => ok(200, JSON.stringify(guest))),
    });
    const result = await doctorAkamai(app);
    expect(result.plain.startsWith("akamai_blocked")).toBe(true);
    expect(result.impersonated.startsWith("session_expired")).toBe(true);
  });

  test("probe loop records death without sleeping for real", async () => {
    let clock = 0;
    let n = 0;
    const records = await runProbeLoop({
      intervalMs: parseDuration("10ms"),
      durationMs: parseDuration("25ms"),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      sample: async () => {
        n++;
        return n < 3
          ? { at: "", outcome: "alive", refresh_attempted: false, refresh_ok: false, detail: "ok" }
          : { at: "", outcome: "session_died", refresh_attempted: true, refresh_ok: false, detail: "gone" };
      },
    });
    expect(records.map((record) => record.outcome)).toEqual(["alive", "alive", "session_died"]);
  });

  test("mcp lists tools and search stays on the fixture", async () => {
    const dir = tempDir();
    const app = createApp({
      sessionPath: path.join(dir, "session.json"),
      redactor: new Redactor(),
      allowSignIn: false,
      transportFor: () => new Scripted(() => ok(200, JSON.stringify(searchBody))),
    });
    const listed = (await handleRpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toContain("checkout_preview");
    expect(names).toContain("submit_otp");
    expect(names).not.toContain("signin_quota_used");
    const called = (await handleRpc(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "search", arguments: { query: "oat", limit: 1 } },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(called.result.isError).toBe(false);
    expect(called.result.content[0]?.text).toContain("Fixture oat drink 1L");
    const server = await startMcpHttp(app, 0);
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await health.json()).toEqual({ ok: true });
    await server.close();
  });

  test("submit_otp does not post the password again", async () => {
    useCreds();
    const dir = tempDir();
    const sessionPath = path.join(dir, "session.json");
    const pausing = loginTransport(true);
    const app = createApp({
      sessionPath,
      redactor: new Redactor(),
      allowSignIn: true,
      transportFor: () => pausing,
      otp: { async take() { return null; } },
    });
    await expect(login(app)).rejects.toMatchObject({ code: "needs_human" });
    const resume = fs.readFileSync(path.join(dir, "mfa-resume.json"), "utf8");
    expect(resume).not.toContain(PASSWORD);
    const postsBefore = pausing.calls.filter((call) => call.method === "POST" && call.url.endsWith("/gol/login")).length;
    await submitOtp(app, "654321");
    const postsAfter = pausing.calls.filter((call) => call.method === "POST" && call.url.endsWith("/gol/login")).length;
    expect(postsAfter).toBe(postsBefore);
    expect(loadSession(sessionPath)?.refreshToken).toBe("fixture-refresh");
  });
});

describe("cli", () => {
  test("--help is headless and has no quota", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts", "--help"], { stdout: "pipe", stderr: "pipe", cwd: root });
    const text = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(text).toContain("checkout");
    expect(text).toContain("mcp");
    expect(text).not.toContain("--cdp-only");
    expect(text).not.toContain("--headed");
    expect(text.toLowerCase()).not.toContain("quota");
  });
});

function raw(transport: Scripted): RawHttp {
  return {
    async request(method, url, opts) {
      const res = await transport.request(method, url, opts);
      return { status: res.status, headers: res.headers, setCookies: res.setCookies, body: res.text };
    },
  };
}

function rawResponse(status: number, body: string, setCookies: string[] = []): RawResponse {
  return { status, headers: {}, setCookies, body };
}
