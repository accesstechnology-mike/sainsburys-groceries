import fs from "node:fs";
import path from "node:path";
import { redactValue, type Redactor } from "../session/redact.ts";

export class TraceWriter {
  readonly file: string;

  constructor(
    file: string,
    private redactor: Redactor,
  ) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  log(event: Record<string, unknown>): void {
    const redacted = this.redactor.redact(JSON.stringify(redactValue(event, this.redactor)));
    fs.appendFileSync(this.file, redacted + "\n", { mode: 0o600 });
  }
}

export function tracePath(traceDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(traceDir, `trace-${stamp}.jsonl`);
}
