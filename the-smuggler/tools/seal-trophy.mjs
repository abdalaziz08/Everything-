// Encrypts the trophy PNG into server/trophy.js (safe to commit; useless without the secret).
//   SMUGGLER_SECRET=<64 hex chars> node tools/seal-trophy.mjs path/to/smuggler_trophy.png
// Make a new secret with:  openssl rand -hex 32
import { readFile, writeFile } from "node:fs/promises";
import { sealTrophy } from "../server/app.js";

const secret = process.env.SMUGGLER_SECRET, png = process.argv[2];
if (!secret || secret.length < 32 || !png) {
  console.error("usage: SMUGGLER_SECRET=<secret, 32+ chars> node tools/seal-trophy.mjs <trophy.png>");
  process.exit(1);
}
const sealed = await sealTrophy(secret, new Uint8Array(await readFile(png)));
const out = new URL("../server/trophy.js", import.meta.url);
await writeFile(out, "// Encrypted trophy (AES-256-GCM). Key is derived from SMUGGLER_SECRET. Made by tools/seal-trophy.mjs\n" +
  "export const TROPHY =\n  " + JSON.stringify(sealed) + ";\n");
console.log("wrote server/trophy.js (" + sealed.length + " chars)");
