import { findWcauthtoken, applySetCookies } from "../session/cookies.ts";
import { saveSession } from "../session/store.ts";
import type { Session } from "../types.ts";
import type { Transport, TransportResponse } from "./transport.ts";

/** Writes Set-Cookie from every response back onto the session and disk. */
export class PersistingTransport implements Transport {
  constructor(
    private inner: Transport,
    private session: Session | null,
    private sessionPath: string,
  ) {}

  async request(
    method: string,
    url: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<TransportResponse> {
    const res = await this.inner.request(method, url, opts);
    if (this.session && res.setCookies.length) {
      this.session.cookies = applySetCookies(this.session.cookies, res.setCookies, url);
      const wc = findWcauthtoken(this.session.cookies);
      if (wc) this.session.wcauthtoken = wc;
      this.session.lastValidatedAt = new Date().toISOString();
      saveSession(this.session, this.sessionPath);
    }
    return res;
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
