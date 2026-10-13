import { BASE_URL, DEFAULT_UA } from "../config.ts";

export const SEC_CH_UA = '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"';

function platformLabel(): string {
  if (process.platform === "darwin") return '"macOS"';
  if (process.platform === "win32") return '"Windows"';
  return '"Linux"';
}

/**
 * Chrome-like header order for a CORS fetch from the groceries SPA.
 * Node's fetch cannot reproduce TLS fingerprints; koonjs does that.
 * Order here is what we pass through to either transport.
 */
export function browserHeaders(
  requestUrl: string,
  extras: Record<string, string> = {},
): Record<string, string> {
  const url = new URL(requestUrl);
  const origin = `${url.protocol}//${url.host}`;
  const referer = extras.referer ?? (origin === new URL(BASE_URL).origin ? `${BASE_URL}/gol-ui/` : `${origin}/`);
  const ordered: [string, string][] = [
    ["sec-ch-ua", SEC_CH_UA],
    ["sec-ch-ua-mobile", "?0"],
    ["sec-ch-ua-platform", platformLabel()],
    ["user-agent", DEFAULT_UA],
    ["accept", extras.accept ?? "application/json, text/plain, */*"],
    ["accept-language", "en-GB,en;q=0.9"],
    ["sec-fetch-site", extras["sec-fetch-site"] ?? "same-origin"],
    ["sec-fetch-mode", "cors"],
    ["sec-fetch-dest", "empty"],
    ["origin", origin],
    ["referer", referer],
  ];
  if (extras["content-type"]) ordered.push(["content-type", extras["content-type"]]);
  if (extras.wcauthtoken) ordered.push(["wcauthtoken", extras.wcauthtoken]);
  if (extras.authorization) ordered.push(["authorization", extras.authorization]);
  if (extras.cookie) ordered.push(["cookie", extras.cookie]);
  const headers: Record<string, string> = {};
  for (const [key, value] of ordered) headers[key] = value;
  for (const [key, value] of Object.entries(extras)) {
    if (value && !(key in headers) && key !== "accept" && key !== "referer") headers[key] = value;
  }
  return headers;
}
