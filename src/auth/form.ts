export interface ParsedForm {
  action: string;
  method: string;
  fields: { name: string; value: string; type: string }[];
}

/** Minimal HTML form parser for the MFA page. Not a browser. */
export function parseForm(html: string, pageUrl: string): ParsedForm | null {
  const formMatch = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!formMatch) return null;
  const attrs = formMatch[1] ?? "";
  const inner = formMatch[2] ?? "";
  const actionAttr = attr(attrs, "action") ?? "";
  const method = (attr(attrs, "method") ?? "get").toUpperCase();
  let action = pageUrl;
  try {
    action = new URL(actionAttr || pageUrl, pageUrl).toString();
  } catch {
    action = pageUrl;
  }
  const fields: ParsedForm["fields"] = [];
  const inputRe = /<input\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRe.exec(inner))) {
    const tag = match[1] ?? "";
    const name = attr(tag, "name");
    if (!name) continue;
    fields.push({
      name,
      value: attr(tag, "value") ?? "",
      type: (attr(tag, "type") ?? "text").toLowerCase(),
    });
  }
  return { action, method, fields };
}

export function codeFieldName(form: ParsedForm): string | null {
  const ranked = ["otp", "mfa_code", "mfaCode", "verification_code", "verificationCode", "code", "token"];
  const names = form.fields.map((field) => field.name);
  for (const wanted of ranked) {
    const found = names.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (found && !/csrf|challenge|blackbox/i.test(found)) return found;
  }
  return (
    names.find((name) => /otp|mfa|verification/i.test(name) && !/csrf|challenge|blackbox/i.test(name)) ?? null
  );
}

export function rememberField(form: ParsedForm): { name: string; value: string } | null {
  const field = form.fields.find(
    (item) => item.type === "checkbox" && /remember|trust|device/i.test(item.name),
  );
  if (!field) return null;
  return { name: field.name, value: field.value || "true" };
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}
