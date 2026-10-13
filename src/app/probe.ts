import { isSessionExpired, SainsburysError } from "../errors.ts";
import type { App } from "./runtime.ts";
import { refresh, whoami } from "./runtime.ts";

export interface ProbeRecord {
  at: string;
  outcome: "alive" | "refresh_extended" | "session_died" | "akamai_blocked" | "needs_human" | "account_flagged";
  refresh_attempted: boolean;
  refresh_ok: boolean;
  detail: string;
}

export async function sampleSession(app: App, now = new Date()): Promise<ProbeRecord> {
  const at = now.toISOString();
  try {
    const profile = (await whoami(app)) as { user_id?: unknown };
    return {
      at,
      outcome: "alive",
      refresh_attempted: false,
      refresh_ok: false,
      detail: `user_id=${String(profile.user_id ?? "")}`,
    };
  } catch (err) {
    if (err instanceof SainsburysError && err.code === "akamai_blocked") {
      return { at, outcome: "akamai_blocked", refresh_attempted: false, refresh_ok: false, detail: err.code };
    }
    if (err instanceof SainsburysError && (err.code === "needs_human" || err.code === "account_flagged")) {
      return { at, outcome: err.code, refresh_attempted: false, refresh_ok: false, detail: err.message };
    }
    if (!isSessionExpired(err) && !(err instanceof SainsburysError)) {
      return { at, outcome: "session_died", refresh_attempted: false, refresh_ok: false, detail: String(err) };
    }
  }
  try {
    const result = await refresh(app);
    if (result.refreshed) {
      return { at, outcome: "refresh_extended", refresh_attempted: true, refresh_ok: true, detail: "profile ok after refresh" };
    }
    return { at, outcome: "session_died", refresh_attempted: true, refresh_ok: false, detail: "refresh did not extend the session" };
  } catch (err) {
    const code = err instanceof SainsburysError ? err.code : "session_expired";
    return {
      at,
      outcome: code === "akamai_blocked" || code === "needs_human" || code === "account_flagged" ? code : "session_died",
      refresh_attempted: true,
      refresh_ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runProbeLoop(opts: {
  intervalMs: number;
  durationMs: number;
  sample: (at: Date) => Promise<ProbeRecord>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<ProbeRecord[]> {
  const started = opts.now();
  const records: ProbeRecord[] = [];
  while (opts.now() - started <= opts.durationMs) {
    const record = await opts.sample(new Date(opts.now()));
    records.push(record);
    if (record.outcome !== "alive" && record.outcome !== "refresh_extended") break;
    if (opts.now() - started + opts.intervalMs > opts.durationMs) break;
    await opts.sleep(opts.intervalMs);
  }
  return records;
}

export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw new Error(`Bad duration ${value}. Use 30s, 5m, or 70m.`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  return amount * 3_600_000;
}
