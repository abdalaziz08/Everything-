// Unit tests: game simulation + server checks. Run: node tests/run-tests.mjs
// A test bot plays a full run against the simulation (takes ~10-20 s), then the server is tested with it.
import { webcrypto } from "node:crypto";
import { createSim, runReplay, encodeReplay, decodeReplay, fingerprint, MAX_FRAMES } from "../public/sim.js";
import { createApp, sealTrophy } from "../server/app.js";
import { botInput } from "./bot.mjs";

let failed = 0;
function check(name, ok, extra = "") {
  console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!ok) failed++;
}
const hex = n => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex");

function botRun(seed) {
  const S = createSim(seed), rec = [];
  while (S.state !== "won" && S.state !== "gameover" && S.frame < MAX_FRAMES) {
    const [x, y, f] = botInput(S);
    rec.push(x & 255, y & 255, f);
    S.step(x, y, f === 1);
  }
  return { S, rec, n: rec.length / 3 };
}
function bytesFor(rec, n) { return encodeReplay(Uint8Array.from(rec), n); }

// ---------- 1. a full bot run, and the replay of it ----------
let seed, run;
for (let i = 0; i < 4; i++) { seed = hex(16); run = botRun(seed); if (run.S.state === "won") break; }
check("bot can win a full game", run.S.state === "won", `${run.n} frames, ~${Math.round(run.n / 60)} s`);
const bytes = bytesFor(run.rec, run.n);
const rep = decodeReplay(bytes);
check("replay encode/decode round trip", rep.n === run.n && rep.qx.every((v, i) => (v & 255) === run.rec[3 * i]), `${bytes.length} bytes`);

// ---------- 2. the simulation never uses engine-dependent Math functions ----------
const saved = {};
for (const k of ["sin", "cos", "tan", "atan", "atan2", "hypot", "random", "exp", "log", "pow", "cbrt", "asin", "acos"]) {
  saved[k] = Math[k]; Math[k] = () => { throw new Error("sim used Math." + k); };
}
let res, err = null;
try { res = runReplay(seed, rep); } catch (e) { err = e; }
Object.assign(Math, saved);
check("replay re-plays to the same win without Math.sin/cos/atan2/hypot/random", !err && res.won && res.fp === fingerprint(run.S), err ? err.message : "");

// ---------- 3. server ----------
const secret = hex(32);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...webcrypto.getRandomValues(new Uint8Array(500))]);
const trophy = await sealTrophy(secret, png);
let clock = 1_800_000_000_000;
const app = createApp({ secret, trophy, now: () => clock });
const post = (path, body) => app.handle(new Request("http://x" + path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }));
const call = async (path, body) => { const r = await post(path, body); return { status: r.status, ...(await r.json()) }; };

const t = await call("/api/start");
check("start gives a ticket and seed", t.status === 200 && /^[0-9a-f]{32}$/.test(t.seed) && t.token.includes("."));

const live = botRun(t.seed);
check("bot wins on the server's seed", live.S.state === "won");
const replay = Buffer.from(bytesFor(live.rec, live.n)).toString("base64");
const playMs = live.n * 1000 / 60;

let r = await call("/api/verify", { token: t.token, replay });
check("rejects a run sent faster than real time", r.status === 403 && /faster/.test(r.error), r.error);

clock += playMs * 0.5;
r = await call("/api/verify", { token: t.token, replay });
check("rejects a run sent after half the needed time", r.status === 403 && /faster/.test(r.error), r.error);

clock += playMs * 0.5 + 2000;
let t0 = Date.now();
r = await call("/api/verify", { token: t.token, replay, fp: fingerprint(live.S) });
const ms = Date.now() - t0;
check("accepts a real winning run and returns the trophy", r.ok === true && Buffer.from(r.png, "base64").equals(Buffer.from(png)), `verify took ${ms} ms`);

const [pl, sig] = t.token.split(".");
const forged = JSON.parse(Buffer.from(pl, "base64url").toString());
forged.t -= 3600_000;
r = await call("/api/verify", { token: Buffer.from(JSON.stringify(forged)).toString("base64url") + "." + sig, replay });
check("rejects a ticket with an edited start time", r.status === 403 && /invalid/.test(r.error), r.error);

const other = createApp({ secret: hex(32), trophy, now: () => clock });
const otherT = await (await other.start()).json();
r = await call("/api/verify", { token: otherT.token, replay });
check("rejects a ticket signed with another secret", r.status === 403 && /invalid/.test(r.error), r.error);

const cut = Buffer.from(bytesFor(live.rec.slice(0, (live.n - 300) * 3), live.n - 300)).toString("base64");
r = await call("/api/verify", { token: t.token, replay: cut });
check("rejects a run that stops before the boss dies", r.status === 403 && /still standing/.test(r.error), r.error);

const t2 = await call("/api/start");
clock += playMs + 5000;
r = await call("/api/verify", { token: t2.token, replay });
check("rejects a winning run recorded on a different seed", r.status === 403 && /smuggler/.test(r.error), r.error);

clock -= playMs + 5000;
r = await call("/api/verify", { token: t.token, replay });
check("still accepts the same ticket within 2 hours", r.ok === true);
clock += 2 * 3600_000 + 1;
r = await call("/api/verify", { token: t.token, replay });
check("rejects an expired ticket", r.status === 403 && /expired/.test(r.error), r.error);

const t3 = await call("/api/start");
clock += 60_000;
const fast = Buffer.from(Uint8Array.from([0x53, 0x31, 10, 100, 0, 0])).toString("base64");
r = await call("/api/verify", { token: t3.token, replay: fast });
check("rejects moves faster than the player can move", r.status === 403 && /corrupt/.test(r.error), r.error);

const tele = Buffer.from(Uint8Array.from([0x53, 0x31, 10, 50, 0, 1])).toString("base64");
r = await call("/api/verify", { token: t3.token, replay: tele });
check("rejects full speed while focused", r.status === 403 && /corrupt/.test(r.error), r.error);

r = await call("/api/verify", { token: t3.token, replay: "AAAA" });
check("rejects garbage", r.status === 403 && /corrupt/.test(r.error), r.error);

const bare = createApp({ secret: undefined, trophy, now: () => clock });
r = await (await bare.start()).json();
check("refuses to run without SMUGGLER_SECRET", r.ok === false && /not configured/.test(r.error));

r = await (await app.handle(new Request("http://x/api/start", { method: "GET" }))).json();
check("only POST is allowed", r.ok === false);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
