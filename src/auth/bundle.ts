/**
 * Pull MFA route hints out of a saved login-ui JS bundle.
 * This does not download anything. The live bundle was not fetched here;
 * `scripts/map-login-js.ts` runs against a file the operator saves.
 */
export interface MfaBundleMap {
  paths: string[];
  verifyPath?: string;
  sendOtpPath?: string;
  rememberField?: string;
  source: "js-bundle";
}

export function mapLoginBundle(source: string): MfaBundleMap {
  const paths = new Set<string>();
  const pathRe = /["'`](\/(?:gol\/login|login-init)(?:\/[A-Za-z0-9_\-./]*)?)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(source))) {
    if (match[1]) paths.add(match[1]);
  }
  const send = first(source, /["'`]([^"'`]*(?:send[-_]?otp|send[-_]?code|resend)[^"'`]*)["'`]/i);
  const remember = first(source, /["'`]((?:remember|trust)[-_]?[A-Za-z]+)["'`]/);
  const list = [...paths];
  const verifyPath = list.find((path) => /verify|confirm/i.test(path)) ?? list.find((path) => /\/mfa\/?$/.test(path));
  const sendOtpPath =
    (send?.startsWith("/") ? send : undefined) ?? list.find((path) => /send|resend/i.test(path));
  return {
    paths: list,
    verifyPath,
    sendOtpPath,
    rememberField: remember,
    source: "js-bundle",
  };
}

function first(source: string, re: RegExp): string | undefined {
  const match = re.exec(source);
  const value = match?.[1];
  if (!value || value.length > 200) return undefined;
  return value;
}
