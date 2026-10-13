import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const held = new AsyncLocalStorage<Set<string>>();
const tails = new Map<string, Promise<unknown>>();
const STALE_MS = 180_000;
const WAIT_MS = 20_000;

/**
 * Cross-process lock around the session file.
 * Re-entrant on the same async call stack; concurrent callers queue.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const current = held.getStore();
  if (current?.has(lockPath)) return fn();

  const prev = tails.get(lockPath) ?? Promise.resolve();
  const run = prev.then(
    () => runExclusive(lockPath, fn),
    () => runExclusive(lockPath, fn),
  );
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(lockPath, settled);
  try {
    return await run;
  } finally {
    if (tails.get(lockPath) === settled) tails.delete(lockPath);
  }
}

async function runExclusive<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await acquire(lockPath);
  const next = new Set(held.getStore());
  next.add(lockPath);
  try {
    return await held.run(next, fn);
  } finally {
    release(lockPath);
  }
}

async function acquire(lockPath: string): Promise<void> {
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (stealIfStale(lockPath)) continue;
      if (Date.now() - started > WAIT_MS) {
        throw new Error(`Timed out waiting for session lock ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function stealIfStale(lockPath: string): boolean {
  let pid: number | undefined;
  let age = STALE_MS + 1;
  try {
    const stat = fs.statSync(lockPath);
    age = Date.now() - stat.mtimeMs;
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    pid = parsed.pid;
  } catch {
    // unreadable lock — only remove it once it is old
  }
  const dead = pid !== undefined && !pidAlive(pid);
  if (!dead && age < STALE_MS) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function release(lockPath: string): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    if (parsed.pid === process.pid) fs.unlinkSync(lockPath);
  } catch {
    // already released
  }
}
