import fs from "node:fs";
import path from "node:path";
import { mapLoginBundle } from "../src/auth/bundle.ts";
import { defaultSessionPath, statePaths } from "../src/config.ts";

/**
 * Read a login-ui JS bundle saved by the operator. Does not download it.
 * Writes the MFA path hints `login` loads from ~/.sainsburys/mfa-map.json.
 */
const file = process.argv[2];
if (!file) {
  console.error("usage: bun scripts/map-login-js.ts <login-ui-bundle.js>");
  process.exit(1);
}
const mapped = mapLoginBundle(fs.readFileSync(file, "utf8"));
const out = statePaths(defaultSessionPath()).mfaMapPath;
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, JSON.stringify(mapped, null, 2), { mode: 0o600 });
console.log(JSON.stringify(mapped, null, 2));
console.log(`wrote ${out}`);
