// Encrypts the stage chain and writes it into index.html.
// Usage: node tools/build.mjs   (reads tools/stages.json + tools/photos.json, both kept out of git)
//
// Stage 1 is in the clear. Each stage's secret (flag, map spot, photo credit, and the whole next
// stage) is AES-GCM encrypted with a random content key. That key is wrapped once per accepted
// city name, with a PBKDF2 key made from the name, so the next stage only opens after the
// right city is pinned. No coordinates are ever in the clear.
import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const here = new URL(".", import.meta.url);
const stages = JSON.parse(readFileSync(new URL("stages.json", here), "utf8"));
const photos = JSON.parse(readFileSync(new URL("photos.json", here), "utf8"));
const b64 = u => Buffer.from(u).toString("base64");
const enc = s => new TextEncoder().encode(s);
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const ITER = 150000;
const sha = async s => Buffer.from(await crypto.subtle.digest("SHA-256", enc(s))).toString("hex");
const gcm = async (rawKey, data) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  return { i: b64(iv), c: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, data))) };
};
async function nameKey(name, salt) {
  const base = await crypto.subtle.importKey("raw", enc(norm(name)), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, 256));
}

let next = null;
for (let n = stages.length - 1; n >= 0; n--) {
  const s = stages[n], p = photos[n];
  const ck = crypto.getRandomValues(new Uint8Array(32)), salt = crypto.getRandomValues(new Uint8Array(16));
  const body = await gcm(ck, enc(JSON.stringify({ flag: s.flag, lat: p.lat, lng: p.lng, credit: p.credit, next })));
  const wraps = [];
  for (const city of s.cities) wraps.push(await gcm(await nameKey(city, salt), ck));
  next = {
    n: n + 1, of: stages.length, level: s.level, hint: s.hint, kind: p.kind,
    start: s.start ?? Math.floor(p.photos.length / 2), photos: p.photos,
    cc: await sha("geo-osint:" + s.cc), sec: { s: b64(salt), it: ITER, w: wraps, ...body },
  };
}

const page = new URL("../index.html", here);
const html = readFileSync(page, "utf8");
const out = html.replace(/\/\*STAGES\*\/.*?\/\*END\*\//s, `/*STAGES*/${JSON.stringify(next)}/*END*/`);
if (out === html) throw new Error("markers not found in index.html");
writeFileSync(page, out);
console.log("wrote", stages.length, "stages");
