// THE SMUGGLER: game rules, shared by the browser (to play) and the server (to check a run).
//
// The server re-plays every run from the recorded inputs, so this code must give the exact
// same result on every JS engine. It only uses + - * /, comparisons, Math.sqrt, Math.round,
// Math.floor, Math.min, Math.max and Math.abs, which every engine computes identically.
// Math.sin/cos/atan2/hypot/random can differ between browsers, so they are not used here.
//
// The randomness for each frame comes from a per-frame seed. The browser does NOT know how to
// make those seeds; it fetches them from the server one window at a time, and the server only
// releases a window once the player has proven (by replay) that they survived the earlier frames
// in real time. So the whole fight's randomness never exists ahead of time: you cannot compute a
// winning run offline, you have to actually play it out.

export const W = 480, H = 640;
export const LIVES = 5;
export const BULLET_SPEED = 0.62;
export const PHASES = [
  { name: "I · CONTRABAND", hp: 420, col: "#ff4d7a" },
  { name: "II · CHECKPOINT", hp: 490, col: "#ffb13d" },
  { name: "III · SMUGGLER'S RUN", hp: 630, col: "#c23bff" },
];

// Player input per frame: movement in 1/16 px (whole numbers) + focus flag.
export const Q = 16;
export const MAX_MOVE = 64;   // 4.0 px per frame
export const MAX_FOCUS = 28;  // 1.75 px per frame while focused
export const MAX_FRAMES = 60 * 60 * 30; // a run can't be longer than 30 minutes

export function inputOk(qx, qy, focus) {
  const m = focus ? MAX_FOCUS : MAX_MOVE;
  return qx * qx + qy * qy <= m * m;
}

// ---------- deterministic math ----------
const PI = 3.141592653589793, TAU = PI * 2, HALF_PI = PI / 2;

const S1 = -1 / 6, S2 = 1 / 120, S3 = -1 / 5040, S4 = 1 / 362880, S5 = -1 / 39916800,
  S6 = 1 / 6227020800, S7 = -1 / 1307674368000, S8 = 1 / 355687428096000, S9 = -1 / 121645100408832000;
export function dsin(x) {
  x = x - Math.round(x / TAU) * TAU;
  if (x > HALF_PI) x = PI - x; else if (x < -HALF_PI) x = -PI - x;
  const z = x * x;
  return x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * (S6 + z * (S7 + z * (S8 + z * S9))))))));
}
export function dcos(x) { return dsin(x + HALF_PI); }

function datan(z) {
  const neg = z < 0; if (neg) z = -z;
  const inv = z > 1; if (inv) z = 1 / z;
  z = z / (1 + Math.sqrt(1 + z * z)); // atan(z) = 2 atan(z / (1 + sqrt(1 + z^2)))
  z = z / (1 + Math.sqrt(1 + z * z));
  const w = z * z;
  let s = -1 / 23;
  for (let k = 10; k >= 0; k--) s = (k % 2 ? -1 : 1) / (2 * k + 1) + w * s;
  s = 4 * z * s;
  if (inv) s = HALF_PI - s;
  return neg ? -s : s;
}
export function datan2(y, x) {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}

// ---------- seeded random (sfc32) ----------
export function makeRand(seedHex) {
  if (!/^[0-9a-f]{32}$/.test(seedHex)) throw new Error("bad seed");
  let a = parseInt(seedHex.slice(0, 8), 16) | 0, b = parseInt(seedHex.slice(8, 16), 16) | 0,
    c = parseInt(seedHex.slice(16, 24), 16) | 0, d = parseInt(seedHex.slice(24, 32), 16) | 0;
  const next = () => {
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
}

// ---------- the game ----------
const SPREAD = [-0.12, 0, 0.12].map(a => ({ vx: dsin(a) * 11, vy: -dcos(a) * 11 }));
const NOFX = {};

// frameSeedFor(frameIndex) -> 32-hex-char seed for that frame (from the server).
// fx: optional visual hooks for the browser (particles, shake, dialog). The server passes none.
export function createSim(frameSeedFor, fx = NOFX) {
  let rand = () => 0;
  const S = {
    state: "intro", stateT: 0, frame: 0, lives: LIVES,
    player: { x: W / 2, y: H - 80, r: 2.6, inv: 0, fire: 0, alive: true },
    boss: { x: W / 2, y: -60, r: 34, phase: 0, hp: PHASES[0].hp, t: 0, flash: 0, tx: W / 2, ty: 130 },
    eb: [], pb: [], lasers: [],
    step,
  };
  const p = S.player, boss = S.boss;

  function setState(s) { S.state = s; S.stateT = 0; }
  function shoot(x, y, a, sp, r, col, extra) {
    sp *= BULLET_SPEED;
    const b = { x, y, vx: dcos(a) * sp, vy: dsin(a) * sp, r, col, t: 0 };
    if (extra) Object.assign(b, extra);
    S.eb.push(b);
  }
  function aim(x, y) { return datan2(p.y - y, p.x - x); }
  function ring(x, y, n, sp, r, col, off) { for (let i = 0; i < n; i++) shoot(x, y, off + i * TAU / n, sp, r, col); }
  function clearBullets() { if (fx.cleared) fx.cleared(S.eb); S.eb.length = 0; S.lasers.length = 0; }

  function pattern() {
    const t = boss.t, ph = boss.phase, bx = boss.x, by = boss.y;
    const frac = boss.hp / PHASES[ph].hp;
    if (ph === 0) {
      boss.tx = W / 2 + dsin(t / 190) * 120; boss.ty = 130 + dsin(t / 97) * 14;
      if (t % 4 === 0) for (let k = 0; k < 4; k++) shoot(bx, by, t * 0.05 + k * TAU / 4, 2.5, 5, "#ff4d7a");
      if (t % 70 === 35) { const a = aim(bx, by); for (let i = -3; i <= 3; i++) shoot(bx, by, a + i * 0.13, 3.6, 4, "#5ef2ff"); }
      if (frac < 0.5 && t % 100 === 0) ring(bx, by, 24, 1.8, 6, "#ff8fb0", rand() * TAU);
    } else if (ph === 1) {
      if (t % 160 === 0) { boss.tx = 90 + rand() * (W - 180); boss.ty = 100 + rand() * 70; }
      if (t % 55 === 0) ring(bx, by, 32, 2.3, 5, "#ffb13d", ((t / 55) % 2) * (PI / 32) + rand() * 0.05);
      if (t % 120 === 60) for (let i = 0; i < 3; i++) shoot(bx, by, HALF_PI + (i - 1) * 0.55, 1.4, 10, "#ffe14d", { crate: 65 });
      if (t % 45 === 20) { const a = aim(bx, by); for (let i = 0; i < 4; i++) shoot(bx, by, a, 4.6 + i * 0.35, 4, "#5ef2ff"); }
    } else {
      boss.tx = W / 2 + dsin(t / 120) * 150; boss.ty = 125 + dsin(t / 61) * 22;
      const sp = frac < 0.3 ? 2.9 : 2.6;
      if (t % 3 === 0) {
        for (let k = 0; k < 2; k++) shoot(bx, by, t * 0.07 + k * PI, sp, 5, "#c23bff");
        for (let k = 0; k < 2; k++) shoot(bx, by, -t * 0.05 + k * PI + HALF_PI, sp, 5, "#ff4d7a");
      }
      if (t % 80 === 40) { const a = aim(bx, by); for (let i = -2; i <= 2; i++) shoot(bx, by, a + i * 0.16, 3.9, 4, "#5ef2ff"); }
      if (t % 50 === 25) { const a = aim(bx, by); for (let i = -1; i <= 1; i++) shoot(bx, by, a + i * 0.22, 3.0, 5, "#e9d9b0", { ghost: 1 }); }
      if (t % 180 === 90) S.lasers.push({ x: p.x, t: 0, warn: 50, on: 40, w: 28 });
      if (frac < 0.3 && t % 90 === 45) ring(bx, by, 28, 1.7, 7, "#ff9be6", rand() * TAU);
    }
  }

  function hitPlayer() {
    if (p.inv > 0) return;
    S.lives--;
    if (fx.hit) fx.hit(p.x, p.y);
    clearBullets();
    if (S.lives <= 0) { p.alive = false; setState("gameover"); return; }
    p.inv = 150; p.x = W / 2; p.y = H - 80;
  }

  // One frame (1/60 s). qx, qy: movement in 1/16 px; focus: true/false.
  function step(qx, qy, focus) {
    S.frame++; S.stateT++;
    if (S.state === "gameover" || S.state === "won") return;
    rand = makeRand(frameSeedFor(S.frame)); // this frame's randomness, from the server

    boss.x += (boss.tx - boss.x) * 0.04; boss.y += (boss.ty - boss.y) * 0.04;
    if (boss.flash > 0) boss.flash--;

    if (S.state === "intro") { boss.tx = W / 2; boss.ty = 130; if (S.stateT > 150) { setState("fight"); boss.t = 0; } }
    if (S.state === "phase" && S.stateT > 130) { setState("fight"); boss.t = 0; }
    if (S.state === "dying") {
      if (fx.dying && S.stateT % 6 === 0) fx.dying(boss.x, boss.y, S.stateT);
      if (S.stateT === 150) { setState("won"); return; }
    }

    // player
    if (S.state !== "dying" && p.alive) {
      p.x += qx / Q; p.y += qy / Q;
      p.x = Math.max(10, Math.min(W - 10, p.x)); p.y = Math.max(20, Math.min(H - 14, p.y));
      if (p.inv > 0) p.inv--;
      if (S.state === "fight" && --p.fire <= 0) {
        p.fire = 4;
        if (focus) { for (const o of [-8, 0, 8]) S.pb.push({ x: p.x + o, y: p.y - 10, vx: 0, vy: -11 }); }
        else { for (const v of SPREAD) S.pb.push({ x: p.x, y: p.y - 10, vx: v.vx, vy: v.vy }); }
      }
    }

    // player bullets
    const hitR = (boss.r + 4) * (boss.r + 4);
    for (const b of S.pb) {
      b.x += b.vx; b.y += b.vy;
      const dx = b.x - boss.x, dy = b.y - boss.y;
      if (S.state === "fight" && dx * dx + dy * dy < hitR) {
        b.dead = true; boss.hp--; boss.flash = 3;
        if (fx.spark) fx.spark(b.x, b.y);
      }
    }
    S.pb = S.pb.filter(b => !b.dead && b.y > -20 && b.x > -20 && b.x < W + 20);

    // boss
    if (S.state === "fight") {
      pattern(); boss.t++;
      if (boss.hp <= 0) {
        clearBullets();
        if (fx.phaseDown) fx.phaseDown(boss.x, boss.y, boss.phase);
        if (boss.phase < 2) {
          boss.phase++; boss.hp = PHASES[boss.phase].hp; setState("phase");
          if (fx.dialog) fx.dialog(["You're persistent. Fine.", "Enough games!"][boss.phase - 1], 120);
        } else {
          setState("dying");
          if (fx.dialog) fx.dialog("Take it... you'll never see what I carried.", 148);
        }
      }
    }

    // enemy bullets
    for (const b of S.eb) {
      b.x += b.vx; b.y += b.vy; b.t++;
      if (b.crate && b.t >= b.crate) {
        b.dead = true; ring(b.x, b.y, 12, 2.8, 4, "#ffe14d", rand() * TAU);
        if (fx.crate) fx.crate(b.x, b.y);
        continue;
      }
      const dx = b.x - p.x, dy = b.y - p.y, rr = b.r * 0.8 + p.r;
      if (p.alive && S.state === "fight" && dx * dx + dy * dy < rr * rr) { b.dead = true; hitPlayer(); break; }
    }
    S.eb = S.eb.filter(b => !b.dead && b.x > -30 && b.x < W + 30 && b.y > -30 && b.y < H + 30);

    // lasers
    for (const L of S.lasers) {
      L.t++;
      if (S.state === "fight" && L.t > L.warn && L.t <= L.warn + L.on && p.y > boss.y && Math.abs(p.x - L.x) < L.w / 2 + p.r) hitPlayer();
    }
    S.lasers = S.lasers.filter(L => L.t <= L.warn + L.on);

    // touching the boss
    const bx = p.x - boss.x, by = p.y - boss.y, br = boss.r + p.r;
    if (S.state === "fight" && p.alive && bx * bx + by * by < br * br) hitPlayer();
  }

  return S;
}

// Short fingerprint of the end state, so the server can tell "desync" apart from "cheating".
export function fingerprint(S) {
  const s = [S.frame, S.lives, S.boss.phase, S.boss.hp, Math.round(S.player.x * 1e6), Math.round(S.player.y * 1e6)].join(",");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

// ---------- replay format ----------
// "S1" then runs of: varint count, qx (int8), qy (int8), flags (bit0 = focus)
export function encodeReplay(rec, n) {
  const out = [0x53, 0x31];
  let i = 0;
  while (i < n) {
    const qx = rec[3 * i], qy = rec[3 * i + 1], fl = rec[3 * i + 2];
    let j = i + 1;
    while (j < n && rec[3 * j] === qx && rec[3 * j + 1] === qy && rec[3 * j + 2] === fl) j++;
    let run = j - i;
    while (run >= 128) { out.push((run & 127) | 128); run >>>= 7; }
    out.push(run, qx & 255, qy & 255, fl);
    i = j;
  }
  return new Uint8Array(out);
}

export function decodeReplay(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x53 || bytes[1] !== 0x31) throw new Error("bad replay");
  const qx = [], qy = [], fl = [];
  let i = 2;
  while (i < bytes.length) {
    let run = 0, shift = 0, c;
    do {
      if (i >= bytes.length || shift > 21) throw new Error("bad replay");
      c = bytes[i++]; run |= (c & 127) << shift; shift += 7;
    } while (c & 128);
    if (run < 1 || i + 3 > bytes.length) throw new Error("bad replay");
    const x = bytes[i] << 24 >> 24, y = bytes[i + 1] << 24 >> 24, f = bytes[i + 2];
    i += 3;
    if (f > 1 || !inputOk(x, y, f === 1)) throw new Error("bad input");
    if (qx.length + run > MAX_FRAMES) throw new Error("run too long");
    for (let k = 0; k < run; k++) { qx.push(x); qy.push(y); fl.push(f); }
  }
  return { qx, qy, fl, n: qx.length };
}

// Turn a flat byte buffer of 16-byte blocks into frameSeedFor: block i (0-based) is frame i+1.
export function seedsFromBytes(bytes) {
  const hex = [];
  for (let i = 0; i + 16 <= bytes.length; i += 16) {
    let s = "";
    for (let j = 0; j < 16; j++) s += bytes[i + j].toString(16).padStart(2, "0");
    hex.push(s);
  }
  return hex; // index with (frame-1)
}

// Play a recorded run from the start. Used by the server.
export function runReplay(frameSeedFor, rep) {
  const S = createSim(frameSeedFor);
  for (let i = 0; i < rep.n; i++) {
    S.step(rep.qx[i], rep.qy[i], rep.fl[i] === 1);
    if (S.state === "won") return { won: true, frames: i + 1, fp: fingerprint(S) };
    if (S.state === "gameover") return { won: false, reason: "died", frames: i + 1, fp: fingerprint(S) };
  }
  return { won: false, reason: "unfinished", frames: rep.n, fp: fingerprint(S) };
}
