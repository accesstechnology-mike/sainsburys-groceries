import { sampleSession, runProbeLoop, parseDuration } from "../src/app/probe.ts";
import { createApp } from "../src/app/runtime.ts";
import { TraceWriter, tracePath } from "../src/api/trace.ts";
import { defaultSessionPath, statePaths } from "../src/config.ts";
import { loadSecretsFromEnv, Redactor } from "../src/session/redact.ts";

/**
 * Calls profile on a saved session every N minutes. No browser and no sign-in.
 * Refresh is attempted only after the profile comes back as a guest or 401.
 */
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  if (key?.startsWith("--")) args.set(key.slice(2), argv[++i] ?? "");
}
if (!args.get("interval") || !args.get("duration")) {
  console.error("usage: bun scripts/session-life-probe.ts --interval 5m --duration 70m [--session path] [--debug]");
  process.exit(1);
}

const sessionPath = args.get("session") || defaultSessionPath();
const redactor = new Redactor();
loadSecretsFromEnv(redactor);
const paths = statePaths(sessionPath);
const trace = args.has("debug") ? new TraceWriter(tracePath(paths.traceDir), redactor) : undefined;
if (trace) console.error(`trace: ${trace.file}`);
const app = createApp({ sessionPath, redactor, trace, allowSignIn: false });

const records = await runProbeLoop({
  intervalMs: parseDuration(args.get("interval")!),
  durationMs: parseDuration(args.get("duration")!),
  sample: (at) => sampleSession(app, at),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});
for (const record of records) console.log(JSON.stringify(record));
const last = records[records.length - 1];
if (last && last.outcome !== "alive" && last.outcome !== "refresh_extended") process.exit(10);
