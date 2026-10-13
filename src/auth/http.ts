import type { Transport } from "../api/transport.ts";

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
}

export interface RawHttp {
  request(
    method: string,
    url: string,
    opts?: { body?: string; headers?: Record<string, string> },
  ): Promise<RawResponse>;
}

export function transportAsRaw(transport: Transport): RawHttp {
  return {
    async request(method, url, opts) {
      const res = await transport.request(method, url, {
        body: opts?.body,
        headers: opts?.headers,
      });
      return {
        status: res.status,
        headers: res.headers,
        setCookies: res.setCookies,
        body: res.text,
      };
    },
  };
}

export function header(res: RawResponse, name: string): string | undefined {
  return res.headers[name.toLowerCase()] ?? res.headers[name];
}

export function locationOf(res: RawResponse, currentUrl: string): string | null {
  const location = header(res, "location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}
