import { applySessionHeaders, normaliseLooseResponse, type Transport, type TransportResponse } from "./transport.ts";
import type { Session } from "../types.ts";

/**
 * Default transport: koonjs (Rust/BoringSSL via napi-rs) reproducing Chrome's
 * TLS + HTTP/2 fingerprints. No browser process.
 */
export class KoonTransport implements Transport {
  private session: Session | null;
  private clientPromise: Promise<KoonLike> | null = null;

  constructor(session: Session | null) {
    this.session = session;
  }

  private async getClient(): Promise<KoonLike> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const mod: KoonModule = await import("koonjs");
        const Koon = mod.Koon ?? mod.default?.Koon;
        if (!Koon) throw new Error("koonjs: Koon export not found. Install optional dependency koonjs, or pass --http.");
        return new Koon({
          browser: "chrome",
          // Login needs the 302/303 itself. Akamai's block is the TLS fingerprint.
          followRedirects: false,
          cookieJar: false,
          locale: "en-GB",
          onRedirect: () => false,
        });
      })();
    }
    return this.clientPromise;
  }

  async request(
    method: string,
    url: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<TransportResponse> {
    const client = await this.getClient();
    const headers = applySessionHeaders(url, this.session, opts, method);
    const m = method.toUpperCase();
    const payload =
      opts.body === undefined || m === "GET" || m === "HEAD"
        ? undefined
        : typeof opts.body === "string"
          ? opts.body
          : JSON.stringify(opts.body);
    const res = await client.request(m, url, payload, { headers, timeout: 40 });
    return normaliseLooseResponse(res);
  }

  async close(): Promise<void> {}
}

interface KoonLike {
  request(
    method: string,
    url: string,
    body: string | undefined,
    opts: { headers: Record<string, string>; timeout: number },
  ): Promise<{ status?: number; text?: (() => string | Promise<string>) | string; headers?: unknown }>;
}

interface KoonModule {
  Koon?: new (opts: {
    browser: string;
    followRedirects?: boolean;
    cookieJar?: boolean;
    locale?: string;
    onRedirect?: () => boolean;
  }) => KoonLike;
  default?: {
    Koon?: new (opts: {
      browser: string;
      followRedirects?: boolean;
      cookieJar?: boolean;
      locale?: string;
      onRedirect?: () => boolean;
    }) => KoonLike;
  };
}
