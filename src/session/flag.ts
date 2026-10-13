import fs from "node:fs";
import path from "node:path";
import { SainsburysError } from "../errors.ts";

export interface AccountFlag {
  flaggedAt: string;
  reason: string;
}

export function readAccountFlag(flagPath: string): AccountFlag | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf8")) as AccountFlag;
    if (!parsed?.reason) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAccountFlag(flagPath: string, reason: string, flaggedAt = new Date().toISOString()): AccountFlag {
  const flag: AccountFlag = { flaggedAt, reason };
  fs.mkdirSync(path.dirname(flagPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(flagPath, JSON.stringify(flag, null, 2), { mode: 0o600 });
  return flag;
}

export function clearAccountFlag(flagPath: string): boolean {
  try {
    fs.unlinkSync(flagPath);
    return true;
  } catch {
    return false;
  }
}

export function assertNotFlagged(flagPath: string): void {
  const flag = readAccountFlag(flagPath);
  if (!flag) return;
  throw new SainsburysError(
    "account_flagged",
    `Account automation is stopped (${flag.reason}). Inspect the account, then run \`sainsburys account-flag clear --acknowledge\` if it is safe to continue. Flagged at ${flag.flaggedAt}.`,
  );
}
