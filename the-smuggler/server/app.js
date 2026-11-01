// THE SMUGGLER — "The Border". Server half.
//
//   POST /api/start                 -> { token, goal, maxStrikes, at, prev, cur }
//   POST /api/step { token, at, decision } -> { correct, actual, streak, strikes, done, won, at, prev, cur, png? }
//
// You are the border guard. Travelers arrive one at a time; a hidden rule (server-only, never sent)
// decides who is a smuggler. You SEARCH or PASS; the server tells you right/wrong and reveals whether
// they really were a smuggler, so you can learn. Reach an 8-in-a-row streak within 5 strikes to win.
// Because the rule lives only here and is often relational or depends on the previous traveler, the
// only way through is human inductive reasoning — there is nothing to read in the page or brute-force.
// Winning releases the AES-GCM-encrypted trophy, whose key comes from SMUGGLER_SECRET.
import { deriveRule, makeTraveler, isSmuggler } from "./rules.js";

export const GOAL = 8;           // correct decisions in a row to win
export const MAX_STRIKES = 5;    // wrong decisions allowed before the session ends
const SESSION_TTL = 20 * 60 * 1000;
const MAX_SESSIONS = 20000;
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

const traits = t => ({ coat: t.coat, crate: t.crate, hat: t.hat, stamp: t.stamp, badge: t.badge });

export function createApp({ secret, trophy, now = () => Date.now() }) {
  let keysP = null, pngB64 = null;
  const configured = typeof secret === "string" && secret.length >= 32 && typeof trophy === "string";
  const keys = () => (keysP ||= deriveKeys(secret));
  const sessions = new Map(); // sid -> { keyBytes, rule, i, streak, strikes, done, won, at }

  function sweep() {
    const cut = now() - SESSION_TTL;
    for (const [sid, s] of sessions) if (s.at < cut) sessions.delete(sid);
    if (sessions.size > MAX_SESSIONS) { const extra = sessions.size - MAX_SESSIONS; let k = 0; for (const sid of sessions.keys()) { sessions.delete(sid); if (++k >= extra) break; } }
  }

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
    try { const t = JSON.parse(dec.decode(b64.unurl(payload))); return t.v === 3 && typeof t.sid === "string" ? t : null; } catch { return null; }
  }
  async function sessionKey(sid) {
    const { subtle, root } = await keys();
    return new Uint8Array(await subtle.sign("HMAC", root, enc.encode("smuggler/insp/" + sid))).slice(0, 16);
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
    if (text.length > 4096) throw { status: 413, msg: "too large" };
    return JSON.parse(text);
  }

  async function start() {
    if (!configured) return reject("server is not configured (SMUGGLER_SECRET missing)", 500);
    sweep();
    const crypto = await getCrypto();
    const sid = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    const keyBytes = await sessionKey(sid);
    const rule = deriveRule(keyBytes);
    const s = { keyBytes, rule, i: 1, streak: 0, strikes: 0, done: false, won: false, at: now() };
    sessions.set(sid, s);
    const payload = b64.url(enc.encode(JSON.stringify({ v: 3, sid, t: now() })));
    return json({
      token: payload + "." + (await sign(payload)), goal: GOAL, maxStrikes: MAX_STRIKES, at: s.i,
      prev: traits(makeTraveler(keyBytes, s.i - 1)), cur: traits(makeTraveler(keyBytes, s.i)),
    });
  }

  async function step(request) {
    if (!configured) return reject("server is not configured", 500);
    let b;
    try { b = await body(request); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const tk = await readToken(b && b.token);
    if (!tk) return reject("invalid ticket");
    const s = sessions.get(tk.sid);
    if (!s) return reject("the booth closed — start again", 409);
    if (s.done) return reject("this shift is over — start again", 409);
    if ((b.at | 0) !== s.i) return reject("out of sync — start again", 409); // replay / double-submit guard
    if (b.decision !== "search" && b.decision !== "pass") return reject("bad decision", 400);
    s.at = now();

    const cur = makeTraveler(s.keyBytes, s.i), prev = makeTraveler(s.keyBytes, s.i - 1);
    const actual = isSmuggler(s.rule, cur, prev);   // true = really a smuggler
    const correct = (b.decision === "search") === actual;
    s.i++;
    if (correct) { s.streak++; if (s.streak >= GOAL) { s.won = true; s.done = true; } }
    else { s.strikes++; s.streak = 0; if (s.strikes >= MAX_STRIKES) s.done = true; }

    const out = { correct, actual, streak: s.streak, strikes: s.strikes, goal: GOAL, maxStrikes: MAX_STRIKES, done: s.done, won: s.won, at: s.i };
    if (s.won) { out.png = await trophyBytes(); sessions.delete(tk.sid); }
    else if (s.done) { sessions.delete(tk.sid); }
    else { out.prev = traits(makeTraveler(s.keyBytes, s.i - 1)); out.cur = traits(makeTraveler(s.keyBytes, s.i)); }
    return json(out);
  }

  async function handle(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return reject("method not allowed", 405);
    if (path === "/api/start") return start();
    if (path === "/api/step") return step(request);
    return reject("not found", 404);
  }

  return { start, step, handle, _sessions: sessions };
}
