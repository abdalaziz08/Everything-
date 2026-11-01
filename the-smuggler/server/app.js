// The server half of THE SMUGGLER.
//
//   POST /api/start                      -> { token }           a signed ticket (session id + start time)
//   POST /api/rng   { token, replay, have } -> { from, to, seeds } the next window of per-frame randomness
//   POST /api/verify{ token, replay, fp } -> { ok, png }        the trophy, only for a real winning run
//
// How the randomness is gated (this is the whole point):
//   * Each frame's randomness is an AES-CTR keystream block under a key only the server knows.
//     The browser can't make these; it must ask the server for them.
//   * /api/rng releases the next CHUNK of frames only after the client proves, by sending the
//     replay of what it has played so far, that it is still alive AND that it has not played more
//     frames than real time allows. So to unlock frame N you must have survived up to ~N already.
//   * That makes the two easy attacks impossible: you can't get the whole fight's randomness up
//     front and solve it offline, and you can't collect it all first and solve it in one shot,
//     because later randomness stays locked until the earlier frames are genuinely survived.
//   The trophy itself is AES-GCM encrypted with a key from SMUGGLER_SECRET, so the code is useless alone.
import { decodeReplay, runReplay, seedsFromBytes, MAX_FRAMES } from "../public/sim.js";

const STEP = 1000 / 60;
const CHUNK = 60;          // frames released per unlock (~1 s)
const LOOKAHEAD = 72;      // frames you may be ahead of real time (reaction buffer, ~1.2 s)
const TOKEN_TTL = 2 * 60 * 60 * 1000;
const MAX_BODY = 4 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder();

async function getCrypto() {
  if (globalThis.crypto && globalThis.crypto.subtle) return globalThis.crypto;
  return (await import("node:crypto")).webcrypto;
}

const b64 = {
  enc(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); },
  dec(str) { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
  url(bytes) { return b64.enc(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  unurl(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return b64.dec(str); },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const reject = (error, status = 403) => json({ ok: false, error }, status);

async function deriveKeys(secret) {
  const crypto = await getCrypto(), subtle = crypto.subtle;
  const root = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sub = async label => new Uint8Array(await subtle.sign("HMAC", root, enc.encode(label)));
  const mac = await subtle.importKey("raw", await sub("smuggler/token"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const aes = await subtle.importKey("raw", await sub("smuggler/trophy"), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return { crypto, subtle, root, mac, aes };
}

export async function sealTrophy(secret, pngBytes) {
  const { crypto, subtle, aes } = await deriveKeys(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
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
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot), sig = token.slice(dot + 1);
    const { subtle, mac } = await keys();
    let ok = false;
    try { ok = await subtle.verify("HMAC", mac, b64.unurl(sig), enc.encode(payload)); } catch { ok = false; }
    if (!ok) return null;
    try {
      const t = JSON.parse(dec.decode(b64.unurl(payload)));
      if (t.v !== 2 || typeof t.sid !== "string" || typeof t.t !== "number") return null;
      return t;
    } catch { return null; }
  }

  // AES-CTR keystream under a per-session key: block (f-1) is the seed for frame f.
  async function frameSeedBytes(sid, count) {
    const { subtle, root } = await keys();
    const raw = new Uint8Array(await subtle.sign("HMAC", root, enc.encode("smuggler/rng/" + sid))).slice(0, 16);
    const key = await subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["encrypt"]);
    const counter = new Uint8Array(16);
    const zeros = new Uint8Array(count * 16);
    return new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, zeros));
  }
  async function frameSeedFor(sid, count) {
    const hex = seedsFromBytes(await frameSeedBytes(sid, Math.max(count, 1)));
    return f => hex[f - 1];
  }

  async function trophyBytes() {
    if (pngB64) return pngB64;
    const { subtle, aes } = await keys();
    const blob = b64.dec(trophy);
    const png = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) }, aes, blob.subarray(12)));
    return (pngB64 = b64.enc(png));
  }

  async function body(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) throw { status: 413, msg: "run too large" };
    return JSON.parse(text);
  }

  async function start() {
    if (!configured) return reject("server is not configured (SMUGGLER_SECRET missing)", 500);
    const crypto = await getCrypto();
    const sid = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    const payload = b64.url(enc.encode(JSON.stringify({ v: 2, sid, t: now() })));
    return json({ token: payload + "." + (await sign(payload)) });
  }

  // Re-play the submitted replay-so-far and say how far it got and whether it's still alive.
  function attest(tk, rep, seeds) {
    if (rep.n === 0) return { frames: 0, alive: true, won: false };
    const res = runReplay(seeds, rep);
    return { frames: res.frames, alive: res.reason !== "died", won: res.won, reason: res.reason };
  }

  async function rng(request) {
    if (!configured) return reject("server is not configured", 500);
    let b;
    try { b = await body(request); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const tk = await readToken(b && b.token);
    if (!tk) return reject("invalid ticket");
    if (now() - tk.t > TOKEN_TTL) return reject("ticket expired, play again");

    let rep = { qx: [], qy: [], fl: [], n: 0 };
    try { if (b.replay) rep = decodeReplay(b64.dec(b.replay)); } catch { return reject("corrupt run"); }

    const elapsedFrames = Math.floor((now() - tk.t) / STEP);
    if (rep.n > elapsedFrames + LOOKAHEAD) return reject("run is ahead of real time");

    const releaseTo = Math.min(rep.n + CHUNK, MAX_FRAMES);
    const seeds = await frameSeedFor(tk.sid, releaseTo);
    const att = attest(tk, rep, seeds);
    if (!att.alive) return reject("the smuggler won that one");

    const have = Math.max(0, Math.min(rep.n, b.have | 0));
    const bytes = (await frameSeedBytes(tk.sid, releaseTo)).subarray(have * 16);
    return json({ from: have + 1, to: releaseTo, seeds: b64.enc(bytes) });
  }

  async function verify(request) {
    if (!configured) return reject("server is not configured", 500);
    let b;
    try { b = await body(request); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const tk = await readToken(b && b.token);
    if (!tk) return reject("invalid ticket");
    const elapsed = now() - tk.t;
    if (elapsed > TOKEN_TTL) return reject("ticket expired, play again");

    let rep;
    try { rep = decodeReplay(b64.dec(b.replay)); } catch { return reject("corrupt run"); }

    if (rep.n > Math.floor(elapsed / STEP) + LOOKAHEAD) return reject("run is ahead of real time");

    const seeds = await frameSeedFor(tk.sid, rep.n + 1);
    const res = runReplay(seeds, rep);
    if (!res.won) {
      console.warn("rejected run", { reason: res.reason, frames: res.frames, sent: rep.n, serverFp: res.fp });
      return reject(res.reason === "died" ? "the smuggler won that one" : "the smuggler is still standing");
    }
    return json({ ok: true, png: await trophyBytes() });
  }

  async function handle(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return reject("method not allowed", 405);
    if (path === "/api/start") return start();
    if (path === "/api/rng") return rng(request);
    if (path === "/api/verify") return verify(request);
    return reject("not found", 404);
  }

  return { start, rng, verify, handle };
}
