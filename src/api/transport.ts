import { browserHeaders } from "./headers.ts";
import { cookieHeaderForUrl } from "../session/cookies.ts";
import type { Session } from "../types.ts";

export interface TransportResponse {
  status: number;
  text: string;
  headers: Record<string, string>;
  setCookies: string[];
}

export interface Transport {
  request(
    method: string,
    url: string,
    opts: { body?: unknown; headers?: Record<string, string> },
  ): Promise<TransportResponse>;
  close(): Promise<void>;
}

export { ApiError, NoSessionError } from "../errors.ts";

/**
 * Plain fetch. Akamai usually answers 403. Kept so `doctor akamai` can show
 * that result next to the impersonated transport. Not a browser.
 */
export class FetchTransport implements Transport {
  private session: Session | null;

  constructor(session: Session | null) {
    this.session = session;
  }

  async request(
    method: string,
    url: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<TransportResponse> {
    const headers = applySessionHeaders(url, this.session, opts, method);
    const res = await fetch(url, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD" || opts.body === undefined
          ? undefined
          : typeof opts.body === "string"
            ? opts.body
            : JSON.stringify(opts.body),
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const flat: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") flat[key] = value;
    });
    return { status: res.status, text: await res.text(), headers: flat, setCookies };
  }

  async close(): Promise<void> {}
}

export function applySessionHeaders(
  url: string,
  session: Session | null,
  opts: { body?: unknown; headers?: Record<string, string> },
  method: string,
): Record<string, string> {
  const extras: Record<string, string> = { ...(opts.headers ?? {}) };
  if (
    opts.body !== undefined &&
    method !== "GET" &&
    method !== "HEAD" &&
    !extras["content-type"] &&
    typeof opts.body !== "string"
  ) {
    extras["content-type"] = "application/json";
  }
  if (session?.wcauthtoken && !extras.wcauthtoken) extras.wcauthtoken = session.wcauthtoken;
  if (session?.accessToken && !extras.authorization) extras.authorization = `Bearer ${session.accessToken}`;
  if (session?.cookies?.length && !extras.cookie) {
    const cookie = cookieHeaderForUrl(session.cookies, url);
    if (cookie) extras.cookie = cookie;
  }
  return browserHeaders(url, extras);
}

export function responseFromLoose(res: {
  status?: number;
  text?: (() => string | Promise<string>) | string;
  headers?: unknown;
}): Promise<TransportResponse> {
  return normaliseLooseResponse(res);
}

export async function normaliseLooseResponse(res: {
  status?: number;
  text?: (() => string | Promise<string>) | string;
  headers?: unknown;
}): Promise<TransportResponse> {
  const rawText = typeof res.text === "function" ? await res.text() : (res.text ?? "");
  const { headers, setCookies } = readLooseHeaders(res.headers);
  return {
    status: Number(res.status ?? 0),
    text: String(rawText),
    headers,
    setCookies,
  };
}

export function readLooseHeaders(input: unknown): { headers: Record<string, string>; setCookies: string[] } {
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  const bag = typeof input === "function" ? (input as () => unknown)() : input;
  if (!bag) return { headers, setCookies };
  if (Array.isArray(bag)) {
    for (const item of bag) {
      if (!item || typeof item !== "object") continue;
      const name = String((item as { name?: unknown }).name ?? "").toLowerCase();
      const value = String((item as { value?: unknown }).value ?? "");
      if (!name) continue;
      pushHeader(headers, setCookies, name, value);
    }
    return { headers, setCookies };
  }
  if (typeof bag !== "object") return { headers, setCookies };
  const entries = bag instanceof Map ? [...bag.entries()] : Object.entries(bag as Record<string, unknown>);
  for (const [key, value] of entries) {
    const name = String(key).toLowerCase();
    const values = Array.isArray(value) ? value.map(String) : [String(value ?? "")];
    for (const item of values) pushHeader(headers, setCookies, name, item);
  }
  return { headers, setCookies };
}

function pushHeader(headers: Record<string, string>, setCookies: string[], name: string, value: string): void {
  if (name === "set-cookie") {
    if (value) setCookies.push(value);
    return;
  }
  headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
}
