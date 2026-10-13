import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  basketAdd,
  basketRemove,
  basketView,
  checkoutConfirm,
  checkoutPreview,
  ordersView,
  search,
  slotsView,
  submitOtp,
  whoami,
  login,
  type App,
} from "../app/runtime.ts";
import { exitCodeFor, SainsburysError } from "../errors.ts";

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  { name: "whoami", description: "Validate the session and return the customer profile.", inputSchema: { type: "object", properties: {} } },
  { name: "search", description: "Search products.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "basket_view", description: "View the current basket.", inputSchema: { type: "object", properties: {} } },
  { name: "basket_add", description: "Add a product by uid or search text.", inputSchema: { type: "object", properties: { product: { type: "string" }, quantity: { type: "number" } }, required: ["product"] } },
  { name: "basket_remove", description: "Remove a basket line by item_uid.", inputSchema: { type: "object", properties: { item_uid: { type: "string" } }, required: ["item_uid"] } },
  { name: "slots_view", description: "View the reservation and slot list.", inputSchema: { type: "object", properties: {} } },
  { name: "orders_view", description: "List orders, or detail one order when order_id is set.", inputSchema: { type: "object", properties: { order_id: { type: "string" } } } },
  { name: "checkout_preview", description: "Show basket, slot and total, and issue a confirm token. Does not place an order.", inputSchema: { type: "object", properties: {} } },
  { name: "checkout_confirm", description: "Place the order only when the preview token still matches. Refuses card challenges.", inputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } },
  { name: "login", description: "HTTP sign-in. Reuses a valid session, refreshes first, then posts credentials. Returns needs_human when an OTP is required.", inputSchema: { type: "object", properties: {} } },
  { name: "submit_otp", description: "Submit the one-time code for the login already in progress. Does not post the password again.", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
];

export async function handleRpc(app: App, message: RpcRequest): Promise<unknown | null> {
  const id = message.id ?? null;
  if (message.method === "notifications/initialized" || message.id === undefined && message.method?.startsWith("notifications/")) {
    return null;
  }
  try {
    if (message.method === "initialize") {
      return result(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sainsburys-groceries", version: "0.5.0" },
      });
    }
    if (message.method === "ping") return result(id, {});
    if (message.method === "tools/list") return result(id, { tools: TOOLS });
    if (message.method === "tools/call") {
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const payload = await callTool(app, params.name ?? "", params.arguments ?? {});
      return result(id, payload);
    }
    return error(id, -32601, `Unknown method ${message.method ?? ""}`);
  } catch (err) {
    const code = err instanceof SainsburysError ? err.code : "error";
    const text = err instanceof Error ? err.message : String(err);
    if (message.method === "tools/call") {
      return result(id, {
        content: [{ type: "text", text: `[${code}] ${text}` }],
        isError: true,
      });
    }
    return error(id, exitCodeFor(err), text);
  }
}

async function callTool(app: App, name: string, args: Record<string, unknown>): Promise<unknown> {
  const signedIn = { ...app, allowSignIn: true };
  switch (name) {
    case "whoami":
      return textResult(await whoami(signedIn));
    case "search":
      return textResult(await search(app, String(args.query ?? ""), Number(args.limit ?? 10)));
    case "basket_view":
      return textResult(await basketView(signedIn));
    case "basket_add":
      return textResult(await basketAdd(signedIn, String(args.product ?? ""), Number(args.quantity ?? 1)));
    case "basket_remove":
      return textResult(await basketRemove(signedIn, String(args.item_uid ?? "")));
    case "slots_view":
      return textResult(await slotsView(signedIn));
    case "orders_view":
      return textResult(await ordersView(signedIn, args.order_id ? String(args.order_id) : undefined));
    case "checkout_preview":
      return textResult(await checkoutPreview(signedIn));
    case "checkout_confirm":
      return textResult(await checkoutConfirm(signedIn, String(args.token ?? "")));
    case "login":
      return textResult(await login(signedIn));
    case "submit_otp":
      return textResult(await submitOtp(app, String(args.code ?? "")));
    default:
      throw new SainsburysError("site_changed", `Unknown tool ${name}`);
  }
}

function textResult(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false };
}

function result(id: number | string | null, value: unknown): unknown {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: number | string | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function startMcpHttp(app: App, port: number, host = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest;
    const body = await handleRpc(app, message);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { jsonrpc: "2.0", id: message.id ?? null, result: {} }));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        port: bound,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

export async function serveMcpStdio(app: App): Promise<void> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const message = JSON.parse(trimmed) as RpcRequest;
    const response = await handleRpc(app, message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
