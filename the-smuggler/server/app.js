// The server half of THE SMUGGLER.
//
//   POST /api/start   -> { token, seed }  a signed ticket with a fresh random seed and the start time
//   POST /api/verify  { token, replay, fp } -> { ok, png }
//
// /api/verify re-plays the whole run with the same game code (public/sim.js). The trophy is only
// sent if that run really beats all 3 phases, and if at least as much real time has passed since
// /api/start as the run takes to play (60 frames per second). The trophy is stored encrypted;
// the key comes from the SMUGGLER_SECRET environment variable, so the public code is useless alone.
import { decodeReplay, runReplay } from "../public/sim.js";

const TOKEN_TTL = 2 * 60 * 60 * 1000; // a run must be submitted within 2 hours of starting
const MAX_BODY = 2 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder();

async function getSubtle() {
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto.subtle;
  return (await import("node:crypto")).webcrypto.subtle;
}

const b64 = {
  enc(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
  url(bytes) { return b64.enc(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  unurl(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return b64.dec(str); },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
const reject = (error, status = 403) => json({ ok: false, error }, status);

// Derive the two keys (token signing, trophy decryption) from the one secret.
async function deriveKeys(secret) {
  const subtle = await getSubtle();
  const root = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sub = async label => new Uint8Array(await subtle.sign("HMAC", root, enc.encode(label)));
  const mac = await subtle.importKey("raw", await sub("smuggler/token"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const aes = await subtle.importKey("raw", await sub("smuggler/trophy"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { subtle, mac, aes };
}

export async function sealTrophy(secret, pngBytes) {
  const { subtle, aes } = await deriveKeys(secret);
  const iv = (globalThis.crypto || (await import("node:crypto")).webcrypto).getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aes, pngBytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64.enc(out);
}

export function createApp({ secret, trophy, now = () => Date.now() }) {
  let keysP = null, pngB64 = null;
  const configured = typeof secret === "string" && secret.length >= 32 && typeof trophy === "string";
  const keys = () => (keysP ||= deriveKeys(secret));

  async function sign(payload) {
    const { subtle, mac } = await keys();
    return b64.url(new Uint8Array(await subtle.sign("HMAC", mac, enc.encode(payload))));
  }

  async function readToken(token) {
    if (typeof token !== "string" || token.length > 400) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const { subtle, mac } = await keys();
    let ok = false;
    try { ok = await subtle.verify("HMAC", mac, b64.unurl(sig), enc.encode(payload)); } catch { ok = false; }
    if (!ok) return null;
    try {
      const t = JSON.parse(dec.decode(b64.unurl(payload)));
      if (t.v !== 1 || typeof t.s !== "string" || typeof t.t !== "number") return null;
      return t;
    } catch { return null; }
  }

  async function trophyBytes() {
    if (pngB64) return pngB64;
    const { subtle, aes } = await keys();
    const blob = b64.dec(trophy);
    const png = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) }, aes, blob.subarray(12)));
    return (pngB64 = b64.enc(png));
  }

  async function start() {
    if (!configured) return reject("server is not configured (SMUGGLER_SECRET missing)", 500);
    const seedBytes = (globalThis.crypto || (await import("node:crypto")).webcrypto).getRandomValues(new Uint8Array(16));
    const seed = [...seedBytes].map(b => b.toString(16).padStart(2, "0")).join("");
    const payload = b64.url(enc.encode(JSON.stringify({ v: 1, s: seed, t: now() })));
    return json({ token: payload + "." + (await sign(payload)), seed });
  }

  async function verify(request) {
    if (!configured) return reject("server is not configured (SMUGGLER_SECRET missing)", 500);
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return reject("run too large", 413);
      body = JSON.parse(text);
    } catch { return reject("bad request", 400); }

    const tk = await readToken(body && body.token);
    if (!tk) return reject("invalid ticket");
    const elapsed = now() - tk.t;
    if (elapsed > TOKEN_TTL) return reject("ticket expired, play again");

    let rep;
    try {
      if (typeof body.replay !== "string") throw new Error();
      rep = decodeReplay(b64.dec(body.replay));
    } catch { return reject("corrupt run"); }

    // The game runs at 60 frames per second, so a real run can't have more frames than time allows.
    const minMs = rep.n * 1000 / 60;
    if (elapsed < minMs * 0.97 - 1500) return reject("run is faster than real time");

    const res = runReplay(tk.s, rep);
    if (!res.won) {
      // A real browser only submits after it saw a win, so this is cheating or a replay mismatch.
      console.warn("rejected run", { reason: res.reason, frames: res.frames, sent: rep.n, clientFp: String(body.fp).slice(0, 16), serverFp: res.fp });
      return reject(res.reason === "died" ? "the smuggler won that one" : "the smuggler is still standing");
    }
    return json({ ok: true, png: await trophyBytes() });
  }

  async function handle(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return reject("method not allowed", 405);
    if (path === "/api/start") return start();
    if (path === "/api/verify") return verify(request);
    return reject("not found", 404);
  }

  return { start, verify, handle };
}
