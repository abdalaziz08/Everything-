// THE SMUGGLER — two stages. Server half.
//
// STAGE 1 — the boss (bullet-hell), randomness streamed in real time so it can't be solved offline:
//   POST /api/s1/start                      -> { token }
//   POST /api/s1/rng   { token, replay, have } -> { from, to, seeds }
//   POST /api/s1/verify{ token, replay }       -> { ok, pass }   a signed proof you beat stage 1 (NOT the trophy)
//
// STAGE 2 — the border (hidden-rule deduction), unlocked only with a stage-1 pass:
//   POST /api/s2/start { pass }                 -> { token, goal, maxStrikes, at, prev, cur }
//   POST /api/s2/step  { token, at, decision }  -> { correct, actual, streak, strikes, done, won, at, prev, cur, png? }
//
// The AES-GCM-encrypted trophy is released only after BOTH stages are won. Its key is from SMUGGLER_SECRET.
import { decodeReplay, runReplay, seedsFromBytes, MAX_FRAMES } from "../public/sim.js";
import { deriveRule, makeTraveler, isSmuggler } from "./rules.js";

// stage 1
const STEP = 1000 / 60, CHUNK = 60, LOOKAHEAD = 72;
// stage 2
export const GOAL = 8, MAX_STRIKES = 5;
// shared
const TOKEN_TTL = 2 * 60 * 60 * 1000;
const SESSION_TTL = 20 * 60 * 1000, MAX_SESSIONS = 20000;
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
  const sessions = new Map();     // stage-2 border sessions: sid -> {...}
  const usedPasses = new Set();   // stage-1 passes already redeemed (single use)
  const passAt = new Map();       // pass sid -> redeemed time (for TTL eviction)

  function sweep() {
    const cut = now() - SESSION_TTL;
    for (const [sid, s] of sessions) if (s.at < cut) sessions.delete(sid);
    for (const [sid, t] of passAt) if (t < now() - TOKEN_TTL) { passAt.delete(sid); usedPasses.delete(sid); }
    if (sessions.size > MAX_SESSIONS) { let k = 0, n = sessions.size - MAX_SESSIONS; for (const sid of sessions.keys()) { sessions.delete(sid); if (++k >= n) break; } }
  }

  async function sign(payload) { const { subtle, mac } = await keys(); return b64.url(new Uint8Array(await subtle.sign("HMAC", mac, enc.encode(payload)))); }
  async function mint(obj) { const p = b64.url(enc.encode(JSON.stringify(obj))); return p + "." + (await sign(p)); }
  async function readToken(token, kind) {
    if (typeof token !== "string" || token.length > 500) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot), sig = token.slice(dot + 1);
    const { subtle, mac } = await keys();
    let ok = false;
    try { ok = await subtle.verify("HMAC", mac, b64.unurl(sig), enc.encode(payload)); } catch { ok = false; }
    if (!ok) return null;
    try { const t = JSON.parse(dec.decode(b64.unurl(payload))); return t.k === kind && typeof t.sid === "string" && typeof t.t === "number" ? t : null; } catch { return null; }
  }
  const randSid = async () => [...(await getCrypto()).getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

  // ---- stage-1 randomness keystream ----
  async function frameSeedBytes(sid, count) {
    const { subtle, root } = await keys();
    const raw = new Uint8Array(await subtle.sign("HMAC", root, enc.encode("smuggler/rng/" + sid))).slice(0, 16);
    const key = await subtle.importKey("raw", raw, { name: "AES-CTR" }, false, ["encrypt"]);
    return new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: 64 }, key, new Uint8Array(count * 16)));
  }
  async function frameSeedFor(sid, count) { const hex = seedsFromBytes(await frameSeedBytes(sid, Math.max(count, 1))); return f => hex[f - 1]; }

  // ---- stage-2 per-session rule key ----
  async function sessionKey(sid) { const { subtle, root } = await keys(); return new Uint8Array(await subtle.sign("HMAC", root, enc.encode("smuggler/insp/" + sid))).slice(0, 16); }

  async function trophyBytes() {
    if (pngB64) return pngB64;
    const { subtle, aes } = await keys();
    const blob = b64.dec(trophy);
    const png = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(0, 12) }, aes, blob.subarray(12)));
    return (pngB64 = b64.enc(png));
  }
  async function body(request, max) {
    const text = await request.text();
    if (text.length > max) throw { status: 413, msg: "too large" };
    return JSON.parse(text);
  }

  // ========================= STAGE 1 (boss) =========================
  async function s1start() {
    if (!configured) return reject("server is not configured (SMUGGLER_SECRET missing)", 500);
    return json({ token: await mint({ k: "s1", sid: await randSid(), t: now() }) });
  }
  async function s1rng(request) {
    if (!configured) return reject("server is not configured", 500);
    let b; try { b = await body(request, 4 * 1024 * 1024); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const tk = await readToken(b && b.token, "s1");
    if (!tk) return reject("invalid ticket");
    if (now() - tk.t > TOKEN_TTL) return reject("ticket expired, play again");
    let rep = { qx: [], qy: [], fl: [], n: 0 };
    try { if (b.replay) rep = decodeReplay(b64.dec(b.replay)); } catch { return reject("corrupt run"); }
    if (rep.n > Math.floor((now() - tk.t) / STEP) + LOOKAHEAD) return reject("run is ahead of real time");
    const releaseTo = Math.min(rep.n + CHUNK, MAX_FRAMES);
    const seeds = await frameSeedFor(tk.sid, releaseTo);
    if (rep.n > 0 && runReplay(seeds, rep).reason === "died") return reject("the smuggler won that one");
    const have = Math.max(0, Math.min(rep.n, b.have | 0));
    return json({ from: have + 1, to: releaseTo, seeds: b64.enc((await frameSeedBytes(tk.sid, releaseTo)).subarray(have * 16)) });
  }
  async function s1verify(request) {
    if (!configured) return reject("server is not configured", 500);
    let b; try { b = await body(request, 4 * 1024 * 1024); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const tk = await readToken(b && b.token, "s1");
    if (!tk) return reject("invalid ticket");
    const elapsed = now() - tk.t;
    if (elapsed > TOKEN_TTL) return reject("ticket expired, play again");
    let rep; try { rep = decodeReplay(b64.dec(b.replay)); } catch { return reject("corrupt run"); }
    if (rep.n > Math.floor(elapsed / STEP) + LOOKAHEAD) return reject("run is ahead of real time");
    const res = runReplay(await frameSeedFor(tk.sid, rep.n + 1), rep);
    if (!res.won) return reject(res.reason === "died" ? "the smuggler won that one" : "the smuggler is still standing");
    // Proof of clearing stage 1 — NOT the trophy. Redeem it once at /api/s2/start.
    return json({ ok: true, pass: await mint({ k: "pass", sid: await randSid(), t: now() }) });
  }

  // ========================= STAGE 2 (border) =========================
  async function s2start(request) {
    if (!configured) return reject("server is not configured", 500);
    sweep();
    let b; try { b = await body(request, 4096); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const pass = await readToken(b && b.pass, "pass");
    if (!pass) return reject("beat the boss first", 401);
    if (now() - pass.t > TOKEN_TTL) return reject("your pass expired — beat the boss again", 401);
    if (usedPasses.has(pass.sid)) return reject("that pass was already used — beat the boss again", 401);
    usedPasses.add(pass.sid); passAt.set(pass.sid, now());

    const sid = await randSid();
    const keyBytes = await sessionKey(sid);
    const s = { keyBytes, rule: deriveRule(keyBytes), i: 1, streak: 0, strikes: 0, done: false, won: false, at: now() };
    sessions.set(sid, s);
    return json({
      token: await mint({ k: "s2", sid, t: now() }), goal: GOAL, maxStrikes: MAX_STRIKES, at: s.i,
      prev: traits(makeTraveler(keyBytes, s.i - 1)), cur: traits(makeTraveler(keyBytes, s.i)),
    });
  }
  async function s2step(request) {
    if (!configured) return reject("server is not configured", 500);
    let b; try { b = await body(request, 4096); } catch (e) { return reject(e.msg || "bad request", e.status || 400); }
    const tk = await readToken(b && b.token, "s2");
    if (!tk) return reject("invalid ticket");
    const s = sessions.get(tk.sid);
    if (!s) return reject("the booth closed — start again", 409);
    if (s.done) return reject("this shift is over — start again", 409);
    if ((b.at | 0) !== s.i) return reject("out of sync — start again", 409);
    if (b.decision !== "search" && b.decision !== "pass") return reject("bad decision", 400);
    s.at = now();
    const cur = makeTraveler(s.keyBytes, s.i), prev = makeTraveler(s.keyBytes, s.i - 1);
    const actual = isSmuggler(s.rule, cur, prev);
    const correct = (b.decision === "search") === actual;
    s.i++;
    if (correct) { s.streak++; if (s.streak >= GOAL) { s.won = true; s.done = true; } }
    else { s.strikes++; s.streak = 0; if (s.strikes >= MAX_STRIKES) s.done = true; }
    const out = { correct, actual, streak: s.streak, strikes: s.strikes, goal: GOAL, maxStrikes: MAX_STRIKES, done: s.done, won: s.won, at: s.i };
    if (s.won) { out.png = await trophyBytes(); sessions.delete(tk.sid); }
    else if (s.done) sessions.delete(tk.sid);
    else { out.prev = traits(makeTraveler(s.keyBytes, s.i - 1)); out.cur = traits(makeTraveler(s.keyBytes, s.i)); }
    return json(out);
  }

  async function handle(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return reject("method not allowed", 405);
    if (path === "/api/s1/start") return s1start();
    if (path === "/api/s1/rng") return s1rng(request);
    if (path === "/api/s1/verify") return s1verify(request);
    if (path === "/api/s2/start") return s2start(request);
    if (path === "/api/s2/step") return s2step(request);
    return reject("not found", 404);
  }

  return { s1start, s1rng, s1verify, s2start, s2step, handle, _sessions: sessions };
}
