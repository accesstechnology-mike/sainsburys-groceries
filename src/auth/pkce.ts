import crypto from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

/** state and nonce are at least 24 characters, as the live authorize call required. */
export function createPkce(): Pkce {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return {
    verifier,
    challenge,
    state: base64url(crypto.randomBytes(24)),
    nonce: base64url(crypto.randomBytes(24)),
  };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}
