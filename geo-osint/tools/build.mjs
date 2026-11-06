// Encrypts the stage chain and writes it into index.html.
// Usage: node tools/build.mjs            (reads tools/stages.json, which stays out of git)
// Each stage's secret (its flag + the next stage) is AES-GCM encrypted with a key
// derived from that stage's city name, so a stage only unlocks after the previous city is found.
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const here = new URL(".", import.meta.url);
const stages = JSON.parse(readFileSync(new URL("stages.json", here), "utf8"));
const b64 = u => Buffer.from(u).toString("base64");
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const ITER = 150000;

async function key(city, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(norm(city)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
}
const sha = async s => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

let next = null;
for (let i = stages.length - 1; i >= 0; i--) {
  const s = stages[i];
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = new TextEncoder().encode(JSON.stringify({ flag: s.flag, next }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(s.city, salt), secret);
  next = { n: i + 1, of: stages.length, level: s.level, lat: s.lat, lng: s.lng, h: s.heading, walk: s.walk || 150, hint: s.hint,
           cc: await sha("geo-osint:" + s.cc), sec: { s: b64(salt), i: b64(iv), c: b64(new Uint8Array(ct)), it: ITER } };
}

const page = new URL("../index.html", here);
const html = readFileSync(page, "utf8");
const out = html.replace(/\/\*STAGES\*\/.*?\/\*END\*\//s, `/*STAGES*/${JSON.stringify(next)}/*END*/`);
if (out === html) throw new Error("markers not found in index.html");
writeFileSync(page, out);
console.log("wrote", stages.length, "stages");
