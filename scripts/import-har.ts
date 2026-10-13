import fs from "node:fs";
import path from "node:path";
import { checkoutEndpoints, parseHar, renderApiMap, sanitiseHar } from "../src/checkout/har.ts";
import { defaultSessionPath, statePaths } from "../src/config.ts";

/**
 * Dev tool. Reads a HAR the operator captured. Writes a sanitised copy,
 * docs/api-map.md, and the checkout map used by `checkout confirm`.
 * It does not call Sainsbury's.
 */
const KNOWN = [
  "GET /groceries-api/gol-services/product/v1/product",
  "GET /groceries-api/gol-services/customer/v1/customer/profile",
  "GET|POST|PUT|DELETE /groceries-api/gol-services/basket/v2/basket",
  "GET|POST|DELETE /groceries-api/gol-services/slot/v1/slot/reservation",
  "GET /groceries-api/gol-services/slot/v1/slots",
  "GET /groceries-api/gol-services/order/v1/order",
  "GET https://account.sainsburys.co.uk/oauth2/auth",
  "POST https://account.sainsburys.co.uk/gol/login",
  "POST https://account.sainsburys.co.uk/oauth2/token",
];

const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/import-har.ts <capture.har> [--out docs/api-map.md]");
  process.exit(1);
}
const raw = fs.readFileSync(file, "utf8");
const sanitised = sanitiseHar(raw);
const sanitisedPath = file.replace(/\.har$/i, "") + ".sanitised.har";
fs.writeFileSync(sanitisedPath, sanitised, { mode: 0o600 });
const endpoints = checkoutEndpoints(parseHar(raw));
const mapPath = statePaths(defaultSessionPath()).apiMapPath;
fs.mkdirSync(path.dirname(mapPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(mapPath, JSON.stringify({ endpoints }, null, 2), { mode: 0o600 });
const docs = path.resolve("docs/api-map.md");
fs.mkdirSync(path.dirname(docs), { recursive: true });
fs.writeFileSync(docs, renderApiMap(endpoints, KNOWN));
console.log(`sanitised: ${sanitisedPath}`);
console.log(`map: ${mapPath}`);
console.log(`docs: ${docs}`);
console.log(endpoints.length ? `checkout endpoints: ${endpoints.map((e) => e.path).join(", ")}` : "checkout confirm still unmapped");
