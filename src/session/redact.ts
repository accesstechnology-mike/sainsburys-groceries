const SENSITIVE_KEYS = new Set([
  "password",
  "pass",
  "csrftoken",
  "csrf_token",
  "cookie",
  "set-cookie",
  "wcauthtoken",
  "authorization",
  "access_token",
  "refresh_token",
  "id_token",
  "email",
  "username",
  "code",
  "login_challenge",
  "consent_challenge",
  "state",
  "code_verifier",
  "client_secret",
]);

const SENSITIVE_QUERY = [
  "code",
  "login_challenge",
  "consent_challenge",
  "state",
  "csrftoken",
  "access_token",
  "refresh_token",
  "id_token",
  "wcauthtoken",
] as const;

export class Redactor {
  private secrets: string[] = [];

  add(secret: string | undefined | null): void {
    if (!secret || secret.length < 4) return;
    if (!this.secrets.includes(secret)) this.secrets.push(secret);
  }

  redact(value: string): string {
    let out = value;
    const secrets = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out;
  }

  redactUnknown(value: unknown): unknown {
    return redactValue(value, this);
  }
}

export function redactValue(value: unknown, redactor = new Redactor()): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactor));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactor.redact(redactUrl(value)) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]";
    } else if (key === "url" && typeof inner === "string") {
      out[key] = redactor.redact(redactUrl(inner));
    } else if ((key === "body" || key === "text") && typeof inner === "string") {
      out[key] = redactor.redact(redactBody(inner));
    } else {
      out[key] = redactValue(inner, redactor);
    }
  }
  return out;
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of SENSITIVE_QUERY) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function redactBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactValue(JSON.parse(body)));
    } catch {
      // fall through to form/text redaction
    }
  }
  return body
    .replace(/(password|csrfToken|refresh_token|access_token|code|login_challenge)=([^&\s]*)/gi, "$1=[redacted]")
    .replace(/(authorization:\s*)(\S+)/gi, "$1[redacted]");
}

export function loadSecretsFromEnv(redactor: Redactor): void {
  redactor.add(process.env.SAINSBURYS_PASSWORD);
  redactor.add(process.env.SAINSBURYS_EMAIL);
  redactor.add(process.env.SAINSBURYS_USERNAME);
  redactor.add(process.env.SAINSBURYS_WCAUTHTOKEN);
  redactor.add(process.env.SAINSBURYS_ACCESS_TOKEN);
  redactor.add(process.env.SAINSBURYS_REFRESH_TOKEN);
  redactor.add(process.env.SAINSBURYS_COOKIE);
}
