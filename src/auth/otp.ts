import fs from "node:fs";

export interface OtpSource {
  /** A code already in hand, or null when the caller must pause. Never logs the code. */
  take(): Promise<string | null>;
}

export function otpFromCode(code: string | undefined): OtpSource {
  const trimmed = code?.trim();
  return { async take() { return trimmed || null; } };
}

export function otpFromFile(file: string, timeoutMs: number, sleep: (ms: number) => Promise<void> = delay): OtpSource {
  return {
    async take() {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const text = fs.readFileSync(file, "utf8").trim();
          const code = text.split(/\s+/)[0];
          if (code) return code;
        } catch {
          // The file is created when the code arrives.
        }
        await sleep(500);
      }
      return null;
    },
  };
}

export function otpFromStdin(timeoutMs: number): OtpSource {
  return {
    take() {
      if (!process.stdin.isTTY) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          process.stdin.pause();
          resolve(null);
        }, timeoutMs);
        process.stdout.write("MFA code: ");
        process.stdin.once("data", (buf: Buffer) => {
          clearTimeout(timer);
          const code = buf.toString().trim().split(/\s+/)[0] ?? "";
          try {
            process.stdin.pause();
          } catch {
            // non-tty edge
          }
          resolve(code || null);
        });
      });
    },
  };
}

export function chainOtp(...sources: OtpSource[]): OtpSource {
  return {
    async take() {
      for (const source of sources) {
        const code = await source.take();
        if (code) return code;
      }
      return null;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
