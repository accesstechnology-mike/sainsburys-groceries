#!/usr/bin/env bun
import fs from "node:fs";
import { Command } from "commander";
import {
  basketAdd,
  basketRemove,
  basketView,
  checkoutConfirm,
  checkoutPreview,
  createApp,
  doctorAkamai,
  doctorApi,
  forgetSession,
  login,
  ordersFind,
  ordersView,
  refresh,
  search,
  slotsBook,
  slotsCancel,
  slotsView,
  submitOtp,
  whoami,
  type App,
} from "./app/runtime.ts";
import { TraceWriter, tracePath } from "./api/trace.ts";
import { chainOtp, otpFromCode, otpFromFile, otpFromStdin, type OtpSource } from "./auth/otp.ts";
import { defaultSessionPath, statePaths } from "./config.ts";
import { exitCodeFor, SainsburysError } from "./errors.ts";
import { serveMcpStdio, startMcpHttp } from "./mcp/server.ts";
import { clearAccountFlag, readAccountFlag } from "./session/flag.ts";
import { loadSecretsFromEnv, Redactor } from "./session/redact.ts";
import { findWcauthtoken, parseCookieHeader, saveSession } from "./session/store.ts";
import { fmtPrice, priceOf, printTable, truncate } from "./util/format.ts";
import type { Basket, Product } from "./types.ts";

const program = new Command();
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

program
  .name("sainsburys")
  .description("Headless Sainsbury's groceries access. TLS-impersonated HTTP only; no browser.")
  .version(version)
  .option("--json", "machine-readable output", false)
  .option("-v, --verbose", "write a sanitised trace file", false)
  .option("--debug", "write a sanitised trace file and print its path", false)
  .option("--trace <path>", "sanitised trace file path")
  .option("--session <path>", "session file path", defaultSessionPath());

function appFor(otp?: OtpSource, allowSignIn = true): App {
  const opts = program.opts<{ verbose?: boolean; debug?: boolean; trace?: string; session: string; json?: boolean }>();
  const redactor = new Redactor();
  loadSecretsFromEnv(redactor);
  const paths = statePaths(opts.session);
  let trace: TraceWriter | undefined;
  if (opts.trace || opts.debug || opts.verbose) {
    trace = new TraceWriter(opts.trace || tracePath(paths.traceDir), redactor);
    console.error(`trace: ${trace.file}`);
  }
  return createApp({
    sessionPath: opts.session,
    redactor,
    trace,
    allowSignIn,
    otp,
  });
}

function fail(err: unknown): never {
  if (err instanceof SainsburysError) console.error(`error: [${err.code}] ${err.message}`);
  else console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(exitCodeFor(err));
}

function emit(value: unknown): void {
  if (program.opts().json) console.log(JSON.stringify(value, null, 2));
}

program
  .command("login")
  .description("HTTP sign-in. Reuses a valid session, refreshes before a new sign-in, then posts credentials. OTP via --mfa, --mfa-file, or a TTY prompt.")
  .option("--mfa <code>", "one-time code for the MFA step already reached")
  .option("--mfa-file <path>", "read the one-time code from this file (same login, no second password post)")
  .action(async (cmd: { mfa?: string; mfaFile?: string }) => {
    const otp = cmd.mfa
      ? otpFromCode(cmd.mfa)
      : cmd.mfaFile
        ? otpFromFile(cmd.mfaFile, 5 * 60_000)
        : chainOtp(otpFromStdin(5 * 60_000));
    try {
      const result = await login(appFor(otp, true));
      if (program.opts().json) console.log(JSON.stringify(result, null, 2));
      else console.log(`sign-in: ${result.action}\nSession saved to ${program.opts().session}`);
    } catch (err) {
      if (err instanceof SainsburysError && err.code === "needs_human" && cmd.mfa) {
        try {
          const result = await submitOtp(appFor(otpFromCode(cmd.mfa), true), cmd.mfa);
          if (program.opts().json) console.log(JSON.stringify(result, null, 2));
          else console.log(`sign-in: ${result.action}\nSession saved to ${program.opts().session}`);
          return;
        } catch (next) {
          fail(next);
        }
      }
      fail(err);
    }
  });

program
  .command("import-cookie-header")
  .description("import cookies pasted from devtools")
  .argument("<cookieHeader>")
  .option("-t, --wcauthtoken <token>", "wcauthtoken request header value")
  .action((header: string, cmd: { wcauthtoken?: string }) => {
    try {
      const cookies = parseCookieHeader(header);
      if (!cookies.length) throw new Error("No cookies parsed from input");
      const session = saveSession(
        {
          cookies,
          wcauthtoken: cmd.wcauthtoken ?? findWcauthtoken(cookies),
          source: "cookie-import",
          established: true,
        },
        program.opts().session,
      );
      console.log(`Imported ${cookies.length} cookies -> ${session}`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("logout")
  .description("delete the saved session")
  .action(() => {
    console.log(forgetSession(program.opts().session) ? "Session deleted" : "No saved session");
  });

program
  .command("refresh")
  .description("try refresh_token, then the silent oauth refresh. Does not sign in.")
  .action(async () => {
    try {
      const result = await refresh(appFor(undefined, false));
      if (program.opts().json) console.log(JSON.stringify(result, null, 2));
      else console.log(result.refreshed ? "refresh: extended" : "refresh: not extended");
    } catch (err) {
      fail(err);
    }
  });

program.command("whoami").description("verify session; show profile summary").action(async () => {
  try {
    const profile = await whoami(appFor());
    if (program.opts().json) return emit(profile);
    printTable(
      Object.entries(profile)
        .filter(([, value]) => typeof value !== "object")
        .map(([field, value]) => ({ field, value: String(value).slice(0, 80) })),
      ["field", "value"],
    );
  } catch (err) {
    fail(err);
  }
});

program
  .command("search")
  .argument("<query>")
  .option("-n, --limit <n>", "results", "10")
  .action(async (query: string, cmd: { limit: string }) => {
    try {
      const res = (await search(appFor(undefined, false), query, Math.min(Number(cmd.limit), 60))) as {
        products?: Product[];
      };
      if (program.opts().json) return emit(res.products ?? res);
      printTable(
        (res.products ?? []).map((product) => ({
          uid: product.product_uid,
          name: truncate(product.name, 55),
          price: fmtPrice(priceOf(product.retail_price) ?? product.retail_price),
          stock: product.in_stock === false ? "out" : "in",
        })),
        ["uid", "name", "price", "stock"],
      );
    } catch (err) {
      fail(err);
    }
  });

const basket = program.command("basket").description("view / edit the current basket");
basket.command("view").action(async () => {
  try {
    const current = (await basketView(appFor())) as Basket;
    if (program.opts().json) return emit(current);
    printTable(
      (current.items ?? []).map((item) => ({
        item_uid: item.item_uid,
        sku: item.product?.sku ?? "?",
        name: truncate(String(item.product?.name ?? "?"), 50),
        qty: item.quantity,
        subtotal: fmtPrice(item.subtotal_price),
      })),
      ["item_uid", "sku", "name", "qty", "subtotal"],
    );
  } catch (err) {
    fail(err);
  }
});
basket
  .command("add")
  .argument("<productOrQuery>")
  .option("-q, --qty <n>", "quantity", "1")
  .action(async (product: string, cmd: { qty: string }) => {
    try {
      const result = await basketAdd(appFor(), product, Number(cmd.qty));
      if (program.opts().json) return emit(result);
      const row = result as { quantity: number; name: string; productUid: string; target: string };
      console.log(`+ ${row.quantity} x ${row.name} (${row.productUid}) -> ${row.target}`);
    } catch (err) {
      fail(err);
    }
  });
basket
  .command("remove")
  .argument("<itemUid>")
  .action(async (itemUid: string) => {
    try {
      const current = (await basketRemove(appFor(), itemUid)) as Basket;
      if (program.opts().json) return emit(current);
      console.log(`removed ${itemUid}; items=${(current.items ?? []).length}`);
    } catch (err) {
      fail(err);
    }
  });

const orders = program.command("orders").description("previous orders over HTTP");
orders
  .command("list")
  .option("-n, --limit <n>", "max orders shown", "10")
  .action(async (cmd: { limit: string }) => {
    try {
      const result = (await ordersView(appFor())) as { orders: { id: string; status?: string; delivery_date?: string; total?: number; amendable?: boolean }[] };
      const rows = result.orders.slice(0, Number(cmd.limit));
      if (program.opts().json) return emit({ via: "http", orders: rows });
      printTable(rows, ["id", "status", "delivery_date", "total", "amendable"]);
    } catch (err) {
      fail(err);
    }
  });
orders
  .command("find")
  .argument("<query>")
  .option("-p, --pages <n>", "history pages", "3")
  .action(async (query: string, cmd: { pages: string }) => {
    try {
      const result = await ordersFind(appFor(), query, Number(cmd.pages));
      if (program.opts().json) return emit(result);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      fail(err);
    }
  });
orders
  .command("view")
  .argument("<orderIdOrLatest>")
  .action(async (orderId: string) => {
    try {
      const result = await ordersView(appFor(), orderId);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      fail(err);
    }
  });
orders.command("latest").action(async () => {
  try {
    const result = await ordersView(appFor(), "latest");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    fail(err);
  }
});

const amend = program.command("amend").description("amend the upcoming order by adding a line");
amend
  .command("add")
  .argument("<productOrQuery>")
  .option("-q, --qty <n>", "quantity", "1")
  .action(async (product: string, cmd: { qty: string }) => {
    try {
      const result = await basketAdd(appFor(), product, Number(cmd.qty));
      if (program.opts().json) emit(result);
      else console.log(JSON.stringify(result));
    } catch (err) {
      fail(err);
    }
  });

const slots = program.command("slots").description("delivery slots over HTTP");
slots.command("reservation").action(async () => {
  try {
    const result = (await slotsView(appFor())) as { reservation: unknown };
    console.log(JSON.stringify(result.reservation, null, 2));
  } catch (err) {
    fail(err);
  }
});
slots.command("list").action(async () => {
  try {
    const result = await slotsView(appFor());
    if (program.opts().json) return emit(result);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    fail(err);
  }
});
slots
  .command("book")
  .argument("<slotId>")
  .action(async (slotId: string) => {
    try {
      const result = await slotsBook(appFor(), slotId);
      if (program.opts().json) emit(result);
      else console.log(`Booked slot ${slotId} (via API)`);
    } catch (err) {
      fail(err);
    }
  });
slots.command("cancel").action(async () => {
  try {
    await slotsCancel(appFor());
    console.log("Reservation cancelled");
  } catch (err) {
    fail(err);
  }
});

const checkout = program.command("checkout").description("two-step checkout. confirm never runs unless the preview token still matches");
checkout.command("preview").description("show basket, slot and total and print a confirm token").action(async () => {
  try {
    const result = await checkoutPreview(appFor());
    if (program.opts().json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(JSON.stringify(result.preview, null, 2));
      console.log(`\npreview token: ${result.token}`);
      console.log("Nothing was purchased. confirm only after the account owner says yes.");
    }
  } catch (err) {
    fail(err);
  }
});
checkout
  .command("confirm")
  .description("continue only when --token matches an unchanged preview")
  .requiredOption("--token <hash>", "token printed by checkout preview")
  .action(async (cmd: { token: string }) => {
    try {
      const result = await checkoutConfirm(appFor(), cmd.token);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      fail(err);
    }
  });

const flag = program.command("account-flag").description("sticky stop after Sainsbury's flags the account");
flag.command("status").action(() => {
  const current = readAccountFlag(statePaths(program.opts().session).flagPath);
  if (!current) console.log("not flagged");
  else console.log(JSON.stringify(current, null, 2));
});
flag
  .command("clear")
  .requiredOption("--acknowledge", "confirm a person reviewed the account")
  .action(() => {
    const removed = clearAccountFlag(statePaths(program.opts().session).flagPath);
    console.log(removed ? "flag cleared" : "not flagged");
  });

const doctor = program.command("doctor").description("diagnostics");
doctor.command("api").action(async () => {
  try {
    const result = await doctorApi(appFor(undefined, false));
    if (program.opts().json) console.log(JSON.stringify(result, null, 2));
    else for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    fail(err);
  }
});
doctor
  .command("akamai")
  .description("compare plain fetch (expect blocked) with TLS impersonation (guest JSON is unauthenticated, not blocked)")
  .action(async () => {
    try {
      const result = await doctorAkamai(appFor(undefined, false));
      if (program.opts().json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`plain-fetch: ${result.plain}`);
        console.log(`impersonated: ${result.impersonated}`);
      }
      process.exitCode = result.impersonated.startsWith("akamai_blocked") ? 13 : 0;
    } catch (err) {
      fail(err);
    }
  });

program
  .command("mcp")
  .description("MCP server. stdio by default; --http binds a local JSON-RPC endpoint")
  .option("--http", "serve HTTP instead of stdio", false)
  .option("--port <n>", "HTTP port", "8787")
  .option("--host <addr>", "HTTP host", "127.0.0.1")
  .action(async (cmd: { http?: boolean; port: string; host: string }) => {
    const app = appFor(undefined, true);
    try {
      if (cmd.http) {
        const server = await startMcpHttp(app, Number(cmd.port), cmd.host);
        console.error(`mcp listening on http://${cmd.host}:${server.port}/`);
        await new Promise(() => {});
      } else {
        await serveMcpStdio(app);
      }
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv);
