// Unit tests for the streamed-RNG server. Run: node tests/run-tests.mjs
// A simulated "live client" plays against the server the way the browser does: it only gets each
// window of randomness after proving, in real time, that it survived the previous frames.
import { webcrypto } from "node:crypto";
import { createSim, runReplay, encodeReplay, decodeReplay, seedsFromBytes, fingerprint, MAX_FRAMES } from "../public/sim.js";
import { createApp, sealTrophy } from "../server/app.js";
import { botInput } from "./bot.mjs";

const STEP = 1000 / 60, CHUNK = 60;
let failed = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  (" + extra + ")" : "")); if (!ok) failed++; };
const hex = n => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex");
const b64 = bytes => Buffer.from(bytes).toString("base64");
const flat = n => Buffer.from(Uint8Array.from(Array(n * 3).fill(0)));
async function call(app, path, body) {
  const r = await app.handle(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }));
  return { status: r.status, ...(await r.json()) };
}

// ---------- a client that plays live, fetching randomness as the (controlled) clock advances ----------
async function playLive(app, state, { horizon = 14, maxFrames = MAX_FRAMES } = {}) {
  const t0 = state.clock;
  const s = await call(app, "/api/start", {});
  if (!s.token) return { error: s };
  const token = s.token, seedHex = [], rec = [];
  let n = 0, calls = 0;
  const S = createSim(f => seedHex[f - 1]);
  async function ensure(upto) {
    let guard = 0;
    while (seedHex.length < upto) {
      if (++guard > 5) return { error: "stuck" };
      state.clock = t0 + n * STEP;               // the client has spent real time playing n frames
      const r = await call(app, "/api/rng", { token, replay: n ? b64(encodeReplay(Uint8Array.from(rec), n)) : "", have: n });
      calls++;
      if (!r.from) return { error: r };
      const hx = seedsFromBytes(Buffer.from(r.seeds, "base64"));
      for (let i = 0; i < hx.length; i++) seedHex[r.from - 1 + i] = hx[i];
      if (r.to >= MAX_FRAMES) break;
    }
    return null;
  }
  while (S.state !== "won" && S.state !== "gameover" && n < maxFrames) {
    const err = await ensure(S.frame + 1);
    if (err) return { error: err.error, frames: n };
    const [x, y, f] = botInput(S, horizon);
    rec.push(x & 255, y & 255, f); S.step(x, y, f === 1); n++;
  }
  state.clock = t0 + n * STEP + 2000;
  return { won: S.state === "won", frames: n, token, replay: b64(encodeReplay(Uint8Array.from(rec), n)), calls };
}

// ---------- set up a server with a known secret and a tiny fake trophy ----------
const secret = hex(32);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...webcrypto.getRandomValues(new Uint8Array(400))]);
const trophy = await sealTrophy(secret, png);
const state = { clock: 1_800_000_000_000 };
const app = createApp({ secret, trophy, now: () => state.clock });

// ---------- 1. a live bot can win, and only then gets the trophy ----------
let game = null;
for (let i = 0; i < 4; i++) { state.clock = 1_800_000_000_000 + i; game = await playLive(app, state); if (game.won) break; }
check("a live bot (randomness streamed in real time) can win", game.won, `${game.frames} frames, ${game.calls} rng calls`);

let v = await call(app, "/api/verify", { token: game.token, replay: game.replay, fp: "x" });
check("verify returns the trophy for a real winning run", v.ok === true && Buffer.from(v.png, "base64").equals(Buffer.from(png)));

// ---------- 2. you cannot pull the whole fight's randomness up front (kills offline precompute) ----------
const s2 = await call(app, "/api/start", {});
state.clock += 0;
const first = await call(app, "/api/rng", { token: s2.token, replay: "", have: 0 });
const framesGot = seedsFromBytes(Buffer.from(first.seeds, "base64")).length;
check("first randomness request releases only one small window, not the whole game", first.to === CHUNK && framesGot === CHUNK, `to=${first.to}`);

// try to jump ahead by claiming a long run at t=0 (collect-then-solve) -> blocked by real-time cadence
const ahead = await call(app, "/api/rng", { token: s2.token, replay: b64(encodeReplay(flat(3000), 3000)), have: 0 });
check("claiming a long run before its time is rejected (no collecting randomness early)", ahead.status === 403 && /ahead of real time/.test(ahead.error), ahead.error);

// even with time elapsed, the next window won't unlock unless you actually survived (here: stood still and died)
const t3 = state.clock;
const s3 = await call(app, "/api/start", {});
state.clock = t3 + 1300 * STEP + 5000; // plenty of real time has passed for a 1300-frame run
const died = await call(app, "/api/rng", { token: s3.token, replay: b64(encodeReplay(flat(1300), 1300)), have: 0 });
check("a run that died does not unlock more randomness", died.status === 403 && /smuggler won/.test(died.error), died.error);

// ---------- 3. verify guards ----------
v = await call(app, "/api/verify", { token: s3.token, replay: b64(encodeReplay(flat(1300), 1300)) });
check("verify rejects a run that did not win", v.status === 403 && !v.ok, v.error);

v = await call(app, "/api/verify", { token: game.token, replay: b64(encodeReplay(Uint8Array.from(game.replay ? [] : []), 0)) });
check("verify rejects an empty run", v.status === 403, v.error);

// a winning replay submitted faster than real time
const fastState = { clock: 1_800_000_000_000 };
const fast = createApp({ secret, trophy, now: () => fastState.clock });
const fgStart = fastState.clock;
const fg = await playLive(fast, fastState);
fastState.clock = fgStart + 1000; // only 1 second of "real time" for an ~80 s run
v = await call(fast, "/api/verify", { token: fg.token, replay: fg.replay });
check("verify rejects a winning run submitted faster than real time", v.status === 403 && /ahead of real time/.test(v.error), fg.won + " " + v.error);

// forged token / other secret / expired / corrupt
const [pl, sig] = game.token.split(".");
const forged = JSON.parse(Buffer.from(pl, "base64url").toString()); forged.t -= 3600_000;
v = await call(app, "/api/verify", { token: Buffer.from(JSON.stringify(forged)).toString("base64url") + "." + sig, replay: game.replay });
check("verify rejects a ticket with an edited start time", v.status === 403 && /invalid/.test(v.error), v.error);

const other = createApp({ secret: hex(32), trophy, now: () => state.clock });
const ot = await call(other, "/api/start", {});
v = await call(app, "/api/verify", { token: ot.token, replay: game.replay });
check("verify rejects a ticket signed with another secret", v.status === 403 && /invalid/.test(v.error), v.error);

state.clock += 3 * 3600_000;
v = await call(app, "/api/verify", { token: game.token, replay: game.replay });
check("verify rejects an expired ticket", v.status === 403 && /expired/.test(v.error), v.error);
state.clock -= 3 * 3600_000;

v = await call(app, "/api/verify", { token: game.token, replay: "@@@" });
check("verify rejects corrupt data", v.status === 403 && /corrupt/.test(v.error), v.error);

// a winning replay from one session can't be reused in another (randomness is per-session)
const other2 = await playLive(app, { clock: state.clock });
v = await call(app, "/api/verify", { token: (await call(app, "/api/start", {})).token, replay: game.replay });
check("a winning replay does not work under a different session", v.status === 403 && !v.ok, v.error);

// not configured / method
const bare = createApp({ secret: undefined, trophy, now: () => state.clock });
v = await (await bare.start()).json();
check("refuses to run without SMUGGLER_SECRET", v.ok === false && /not configured/.test(v.error));
v = await (await app.handle(new Request("http://x/api/rng", { method: "GET" }))).json();
check("only POST is allowed", v.ok === false);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
