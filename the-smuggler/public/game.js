// THE SMUGGLER: browser side. Draws the game, reads input, records every frame of input,
// and sends the recording to the server, which re-plays it and hands over the trophy only for a real win.
import { createSim, fingerprint, encodeReplay, inputOk, W, H, LIVES, PHASES, Q, MAX_MOVE, MAX_FOCUS, MAX_FRAMES } from "./sim.js";

const STEP = 1000 / 60, TAU = Math.PI * 2;
const cv = document.getElementById("c"), ctx = cv.getContext("2d");
let R = 1;
function fit() {
  const s = Math.min(innerWidth / W, innerHeight / H), dpr = window.devicePixelRatio || 1;
  R = s * dpr; cv.width = Math.round(W * R); cv.height = Math.round(H * R);
  cv.style.width = Math.round(W * s) + "px"; cv.style.height = Math.round(H * s) + "px";
}
addEventListener("resize", fit); fit();

// ---------- state ----------
let mode = "title";      // title | connecting | play | sending | done
let S = null;            // the running game (from sim.js)
let run = null;          // { token, rec, n, body }
let session = null, sessionP = null, netMsg = "";
let paused = false, tick = 0, shake = 0, dialog = null, parts = [];

// ---------- input ----------
const keys = Object.create(null);
addEventListener("keydown", e => {
  keys[e.code] = true;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  if (e.code === "Enter" || e.code === "Space") press();
  if (e.code === "KeyP" && S && S.state === "fight" && mode === "play") paused = !paused;
});
addEventListener("keyup", e => { keys[e.code] = false; });
addEventListener("blur", () => { for (const k in keys) keys[k] = false; if (S && S.state === "fight") paused = true; });
document.addEventListener("visibilitychange", () => { if (document.hidden && S && S.state === "fight") paused = true; });

let touch = null;
function tpos(t) { const r = cv.getBoundingClientRect(); return { x: (t.clientX - r.left) / r.width * W, y: (t.clientY - r.top) / r.height * H }; }
cv.addEventListener("touchstart", e => {
  e.preventDefault(); const p = tpos(e.changedTouches[0]);
  touch = { x: p.x, y: p.y, px: S ? S.player.x : W / 2, py: S ? S.player.y : H - 80 }; press();
}, { passive: false });
cv.addEventListener("touchmove", e => {
  e.preventDefault(); if (!touch) return; const p = tpos(e.changedTouches[0]);
  touch.tx = touch.px + (p.x - touch.x) * 1.2; touch.ty = touch.py + (p.y - touch.y) * 1.2;
}, { passive: false });
cv.addEventListener("touchend", e => { e.preventDefault(); touch = null; }, { passive: false });
cv.addEventListener("mousedown", () => press());

// One frame of input, as whole 1/16 px steps (exactly what gets recorded and sent).
function readInput() {
  const p = S.player, focus = !!(keys.ShiftLeft || keys.ShiftRight), sp = focus ? 1.7 : 4.0;
  let dx = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
  let dy = (keys.ArrowDown || keys.KeyS ? 1 : 0) - (keys.ArrowUp || keys.KeyW ? 1 : 0);
  if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
  let vx = dx * sp, vy = dy * sp;
  if (touch && touch.tx !== undefined) {
    const ddx = touch.tx - (p.x + vx), ddy = touch.ty - (p.y + vy), d = Math.hypot(ddx, ddy);
    if (d > 0.5) { const m = Math.min(d, 4.0); vx += ddx / d * m; vy += ddy / d * m; }
  }
  let qx = Math.round(vx * Q), qy = Math.round(vy * Q);
  const max = focus ? MAX_FOCUS : MAX_MOVE, len = Math.hypot(qx, qy);
  if (len > max) { qx = Math.trunc(qx * max / len); qy = Math.trunc(qy * max / len); }
  while (!inputOk(qx, qy, focus)) { qx -= Math.sign(qx); qy -= Math.sign(qy); }
  return [qx, qy, focus ? 1 : 0];
}

// ---------- server ----------
// The randomness for the fight is NOT in this page. We fetch it from the server one window at a
// time, and the server only unlocks the next window once our replay-so-far proves we survived the
// earlier frames in real time. So nobody (human or script) can compute a winning run offline.
const LOWWATER = 20;          // refill the seed buffer when within this many frames of the end
let seedHex = [];             // seedHex[f-1] = randomness for frame f
let fetching = false, syncing = false;

function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(str) { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

function fetchSession() {
  sessionP = fetch("/api/start", { method: "POST" })
    .then(r => r.json())
    .then(j => { if (!j.token) throw new Error(j.error || "no ticket"); session = { token: j.token, at: Date.now() }; return session; })
    .finally(() => { sessionP = null; });
  return sessionP;
}
fetchSession().catch(() => {});

async function pumpSeeds() {
  if (fetching || !run || mode !== "play") return;
  if (seedHex.length > run.n + LOWWATER) return;
  fetching = true;
  try {
    const replay = run.n ? b64(encodeReplay(run.rec, run.n)) : "";
    const r = await fetch("/api/rng", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: run.token, replay, have: run.n }) });
    const j = await r.json();
    if (!j.seeds) { netMsg = String(j.error || "lost the border").toUpperCase(); return; }
    const bytes = unb64(j.seeds);
    for (let i = 0; i + 16 <= bytes.length; i += 16) {
      let s = ""; for (let k = 0; k < 16; k++) s += bytes[i + k].toString(16).padStart(2, "0");
      seedHex[j.from - 1 + i / 16] = s;
    }
    netMsg = "";
  } catch { netMsg = "CONNECTION HICCUP..."; }
  finally { fetching = false; }
}

async function begin(again) {
  const back = mode;
  mode = "connecting"; netMsg = "";
  try {
    if (session && Date.now() - session.at > 30 * 60 * 1000) session = null;
    if (!session) await (sessionP || fetchSession());
  } catch {
    mode = back; netMsg = "CAN'T REACH THE BORDER. TAP TO RETRY"; return false;
  }
  const s = session; session = null;
  run = { token: s.token, rec: new Uint8Array(3 * 60 * 60 * 3), n: 0, body: null };
  seedHex = []; syncing = false;
  parts = []; shake = 0; paused = false;
  if (touch) { touch.px = W / 2; touch.py = H - 80; touch.tx = undefined; }
  S = createSim(f => seedHex[f - 1], fx);
  mode = "play";
  dialog = again ? { text: "Back for more? Turn around.", t: 120 } : { text: "Nothing crosses my border.", t: 150 };
  pumpSeeds().catch(() => {});            // first window of randomness
  fetchSession().catch(() => {});         // ticket for the next attempt
  return true;
}

function press() {
  if (mode === "title") begin(false);
  else if (mode === "play" && S.state === "gameover" && S.stateT > 40) begin(true);
}

function record(qx, qy, f) {
  if (3 * (run.n + 1) > run.rec.length) { const r = new Uint8Array(run.rec.length * 2); r.set(run.rec); run.rec = r; }
  run.rec[3 * run.n] = qx & 255; run.rec[3 * run.n + 1] = qy & 255; run.rec[3 * run.n + 2] = f; run.n++;
}

const win = document.getElementById("win"), $ = id => document.getElementById(id);
function overlay(title, msg, show = []) {
  win.querySelector("h1").textContent = title; $("msg").textContent = msg;
  for (const id of ["dl", "retry", "again"]) $(id).hidden = !show.includes(id);
  win.classList.add("on");
}
$("retry").onclick = () => send();
$("again").onclick = async () => {
  win.classList.remove("on"); $("trophy").removeAttribute("src");
  if (!(await begin(true))) overlay("CONNECTION LOST", "CAN'T REACH THE BORDER.", ["again"]);
};

function submit() {
  mode = "sending";
  run.body = JSON.stringify({ token: run.token, replay: b64(encodeReplay(run.rec, run.n)), fp: fingerprint(S) });
  send();
}
async function send() {
  overlay("VERIFYING", "THE BORDER GUARDS ARE CHECKING YOUR RUN...");
  let j;
  try {
    const r = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: run.body });
    j = await r.json();
  } catch {
    overlay("CONNECTION LOST", "YOUR RUN IS SAFE. SEND IT AGAIN.", ["retry", "again"]); return;
  }
  mode = "done";
  if (!j.ok) { overlay("REJECTED", String(j.error || "the border said no").toUpperCase(), ["again"]); return; }
  const url = URL.createObjectURL(new Blob([unb64(j.png)], { type: "image/png" }));
  $("trophy").src = url; $("dl").href = url;
  overlay("VICTORY", "THE SMUGGLER HAS FALLEN. YOUR TROPHY AWAITS.", ["dl"]);
}

// ---------- visuals hooked into the game ----------
function burst(x, y, col, n, spd) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = Math.random() * spd;
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 30 + Math.random() * 30, col });
  }
}
const fx = {
  cleared(eb) { for (const b of eb) parts.push({ x: b.x, y: b.y, vx: 0, vy: -1, life: 24, col: "#f3d27a" }); },
  hit(x, y) { shake = 18; burst(x, y, "#5ef2ff", 40, 5); },
  spark(x, y) { if (Math.random() < 0.3) parts.push({ x, y, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 2, life: 14, col: "#fff" }); },
  phaseDown(x, y, ph) { burst(x, y, PHASES[ph].col, 60, 7); shake = 14; },
  crate(x, y) { burst(x, y, "#ffe14d", 10, 3); },
  dying(x, y, t) { burst(x + (Math.random() - 0.5) * 80, y + (Math.random() - 0.5) * 80, ["#ff4d7a", "#f3d27a", "#c23bff"][t % 3], 18, 6); shake = 8; },
  dialog(text, t) { dialog = { text, t }; },
};

// ---------- update ----------
function update() {
  tick++;
  if (shake > 0) shake--;
  for (const q of parts) { q.x += q.vx; q.y += q.vy; q.vx *= 0.96; q.vy *= 0.96; q.life--; }
  parts = parts.filter(q => q.life > 0);
  if (dialog && --dialog.t <= 0) dialog = null;
  if (mode !== "play") return;
  if (S.state === "gameover") { S.step(0, 0, false); return; }
  if (paused && S.state === "fight") return;
  if (run.n >= MAX_FRAMES) { mode = "done"; overlay("TOO SLOW", "THE BORDER CLOSED. 30 MINUTES IS THE LIMIT.", ["again"]); return; }
  if (seedHex.length < S.frame + 1) { syncing = true; pumpSeeds().catch(() => {}); return; } // wait for the server's randomness
  syncing = false;
  if (seedHex.length <= run.n + LOWWATER) pumpSeeds().catch(() => {});
  const [qx, qy, f] = readInput();
  record(qx, qy, f);
  S.step(qx, qy, f === 1);
  if (S.state === "won") { dialog = null; submit(); }
}

// ---------- render ----------
const stars = Array.from({ length: 90 }, () => ({ x: Math.random() * W, y: Math.random() * H, s: Math.random() * 1.6 + 0.3, v: Math.random() * 1.2 + 0.3 }));
function txt(s, x, y, size, col, align, glow) {
  ctx.font = "bold " + size + "px 'Courier New',monospace"; ctx.textAlign = align || "center";
  ctx.fillStyle = col; if (glow) { ctx.shadowColor = col; ctx.shadowBlur = glow; } ctx.fillText(s, x, y); ctx.shadowBlur = 0;
}

function drawBoss(x, y, p, flash) {
  const pulse = Math.sin(tick / 10);
  ctx.save(); ctx.translate(x, y);
  const g = ctx.createRadialGradient(0, 0, 10, 0, 0, 80 + pulse * 6);
  g.addColorStop(0, "rgba(255,40,70,.35)"); g.addColorStop(1, "rgba(255,40,70,0)");
  if (p === 2) g.addColorStop(0, "rgba(194,59,255,.45)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 86, 0, TAU); ctx.fill();
  ctx.fillStyle = "#3a060a";
  ctx.beginPath(); ctx.moveTo(-22, -26); ctx.quadraticCurveTo(-44, -50, -36, -74); ctx.quadraticCurveTo(-28, -50, -8, -34); ctx.fill();
  ctx.beginPath(); ctx.moveTo(22, -26); ctx.quadraticCurveTo(44, -50, 36, -74); ctx.quadraticCurveTo(28, -50, 8, -34); ctx.fill();
  const fg = ctx.createRadialGradient(-10, -12, 4, 0, 0, 40);
  fg.addColorStop(0, "#d42a3c"); fg.addColorStop(1, "#5a0812");
  ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, 0, 36, 0, TAU); ctx.fill();
  if (flash) { ctx.fillStyle = "rgba(255,235,235,.28)"; ctx.beginPath(); ctx.arc(0, 0, 36, 0, TAU); ctx.fill(); }
  ctx.strokeStyle = "#1a0306"; ctx.lineWidth = 3; ctx.stroke();
  const eye = p === 2 ? "#ff3bf2" : "#ffd23d";
  ctx.fillStyle = "#1a0306";
  ctx.beginPath(); ctx.moveTo(-26, -14); ctx.lineTo(-6, -6); ctx.lineTo(-8, -1); ctx.lineTo(-26, -8); ctx.fill();
  ctx.beginPath(); ctx.moveTo(26, -14); ctx.lineTo(6, -6); ctx.lineTo(8, -1); ctx.lineTo(26, -8); ctx.fill();
  ctx.fillStyle = eye; ctx.shadowColor = eye; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.ellipse(-15, 0, 6, 4, 0.3, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(15, 0, 6, 4, -0.3, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = "#1a0306"; ctx.beginPath(); ctx.moveTo(-20, 14); ctx.quadraticCurveTo(0, 32, 20, 14); ctx.quadraticCurveTo(0, 22, -20, 14); ctx.fill();
  ctx.fillStyle = "#f3e6c8";
  for (const fx of [-12, 8]) { ctx.beginPath(); ctx.moveTo(fx, 17); ctx.lineTo(fx + 4, 26); ctx.lineTo(fx + 8, 18); ctx.fill(); }
  ctx.restore();
}

function render() {
  ctx.setTransform(R, 0, 0, R, 0, 0);
  if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 0.6, (Math.random() - 0.5) * shake * 0.6);
  ctx.fillStyle = "#07060b"; ctx.fillRect(-20, -20, W + 40, H + 40);
  ctx.strokeStyle = "rgba(255,60,90,.05)"; ctx.lineWidth = 1; const off = (tick * 0.6) % 32;
  for (let y = -32 + off; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (const s of stars) { s.y += s.v; if (s.y > H) s.y = 0; ctx.fillStyle = "rgba(233,217,176," + (0.25 + s.s * 0.25) + ")"; ctx.fillRect(s.x, s.y, s.s, s.s); }

  if (!S || mode === "title" || (mode === "connecting" && !S)) { drawTitle(); return; }

  const { player, boss, eb, pb, lasers } = S, st = S.state;
  for (const L of lasers) {
    if (L.t <= L.warn) {
      ctx.strokeStyle = "rgba(255,60,90," + (0.25 + 0.35 * Math.abs(Math.sin(L.t / 4))) + ")"; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(L.x, boss.y); ctx.lineTo(L.x, H); ctx.stroke(); ctx.setLineDash([]);
    } else {
      const k = 1 - (L.t - L.warn) / L.on; ctx.fillStyle = "rgba(194,59,255," + (0.35 + 0.4 * k) + ")";
      ctx.shadowColor = "#c23bff"; ctx.shadowBlur = 20; ctx.fillRect(L.x - L.w / 2, boss.y, L.w, H);
      ctx.fillStyle = "rgba(255,255,255," + (0.6 * k + 0.2) + ")"; ctx.fillRect(L.x - L.w / 6, boss.y, L.w / 3, H); ctx.shadowBlur = 0;
    }
  }

  if (!(st === "won" || (st === "dying" && S.stateT > 140))) drawBoss(boss.x, boss.y, boss.phase, boss.flash);

  ctx.fillStyle = "#9ff7ff"; for (const b of pb) ctx.fillRect(b.x - 1.5, b.y - 6, 3, 10);

  if (player.alive && !(player.inv > 0 && Math.floor(tick / 4) % 2)) {
    const focus = keys.ShiftLeft || keys.ShiftRight;
    ctx.save(); ctx.translate(player.x, player.y);
    ctx.fillStyle = "#1fb6c9"; ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(10, 10); ctx.lineTo(0, 5); ctx.lineTo(-10, 10); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#9ff7ff"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.shadowColor = focus ? "#fff" : "#5ef2ff"; ctx.shadowBlur = focus ? 14 : 6;
    ctx.beginPath(); ctx.arc(0, 0, focus ? 3.4 : 2.6, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
    if (focus) { ctx.strokeStyle = "rgba(255,255,255,.4)"; ctx.beginPath(); ctx.arc(0, 0, 9 + Math.sin(tick / 6), 0, TAU); ctx.stroke(); }
    ctx.restore();
  }

  for (const b of eb) {
    if (b.ghost) { const d = Math.hypot(b.x - player.x, b.y - player.y); ctx.globalAlpha = d > 120 ? 0.1 : 0.1 + 0.9 * (1 - d / 120); }
    ctx.fillStyle = b.col; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.5, 0, TAU); ctx.fill();
    if (b.crate) { ctx.strokeStyle = "#1a0306"; ctx.lineWidth = 2; ctx.strokeRect(b.x - 5, b.y - 5, 10, 10); }
    ctx.globalAlpha = 1;
  }
  drawParts();

  // HUD
  ctx.setTransform(R, 0, 0, R, 0, 0);
  txt("THE SMUGGLER", 14, 24, 15, "#f3d27a", "left");
  if (st !== "won") {
    const ph = PHASES[boss.phase]; txt(ph.name, W - 14, 24, 12, ph.col, "right");
    const bw = W - 28; ctx.fillStyle = "#1a0f12"; ctx.fillRect(14, 32, bw, 8);
    for (let i = 0; i < 3; i++) {
      const seg = bw / 3, x0 = 14 + i * seg;
      let f = i < boss.phase ? 0 : i > boss.phase ? 1 : Math.max(0, boss.hp) / PHASES[i].hp;
      if (st === "dying") f = 0; ctx.fillStyle = PHASES[i].col; ctx.fillRect(x0 + 1, 33, (seg - 2) * f, 6);
    }
  }
  for (let i = 0; i < LIVES; i++) { ctx.fillStyle = i < S.lives ? "#ff4d7a" : "#3a1a22"; drawHeart(18 + i * 20, H - 18); }
  if (st === "phase" && S.stateT < 110) txt(PHASES[boss.phase].name, W / 2, H / 2, 24, PHASES[boss.phase].col, "center", 14);
  if (dialog) {
    ctx.fillStyle = "rgba(5,4,9,.75)"; ctx.fillRect(30, H - 118, W - 60, 40); ctx.strokeStyle = "#7a5a22"; ctx.strokeRect(30, H - 118, W - 60, 40);
    txt("“" + dialog.text + "”", W / 2, H - 92, 14, "#f3d27a");
  }
  if (paused && st === "fight") {
    ctx.fillStyle = "rgba(5,4,9,.7)"; ctx.fillRect(0, 0, W, H); txt("PAUSED", W / 2, H / 2, 30, "#f3d27a", "center", 12);
    txt("press P", W / 2, H / 2 + 30, 13, "#b5645a");
  }
  if (st === "gameover") {
    ctx.fillStyle = "rgba(5,4,9,.78)"; ctx.fillRect(0, 0, W, H);
    txt("GAME OVER", W / 2, H / 2 - 20, 38, "#ff4d7a", "center", 16);
    txt("The Smuggler slips away.", W / 2, H / 2 + 16, 14, "#e9d9b0");
    if (mode === "connecting") txt("CONTACTING THE BORDER...", W / 2, H / 2 + 60, 14, "#5ef2ff");
    else if (netMsg) txt(netMsg, W / 2, H / 2 + 60, 13, "#ff4d7a");
    else if (S.stateT > 40 && Math.floor(tick / 30) % 2) txt("PRESS ENTER / TAP TO RETRY", W / 2, H / 2 + 60, 14, "#5ef2ff");
  }
  if (syncing && st !== "gameover" && Math.floor(tick / 20) % 2) txt("SYNCING...", W / 2, H - 150, 12, "#5ef2ff");
  if (netMsg && st !== "gameover") txt(netMsg, W / 2, H - 134, 11, "#ff9be6");
}

function drawTitle() {
  txt("THE SMUGGLER", W / 2, 210, 42, "#f3d27a", "center", 18);
  txt("— a boss you were not meant to beat —", W / 2, 245, 13, "#b5645a");
  drawBoss(W / 2, 330 + Math.sin(tick / 30) * 4, 0, 0);
  const rows = [["ARROWS / WASD", "move"], ["SHIFT", "focus (slow + precise)"], ["P", "pause"]];
  rows.forEach(([k, v], i) => { txt(k, 215, 430 + i * 22, 14, "#f3d27a", "right"); txt(v, 235, 430 + i * 22, 14, "#e9d9b0", "left"); });
  txt("touch: drag to move · fire is automatic", W / 2, 500, 12, "#7d6a48");
  txt(LIVES + " LIVES. NO CONTINUES.", W / 2, 540, 14, "#ff4d7a");
  if (mode === "connecting") txt("CONTACTING THE BORDER...", W / 2, 585, 16, "#5ef2ff", "center", 10);
  else if (netMsg) txt(netMsg, W / 2, 585, 14, "#ff4d7a");
  else if (Math.floor(tick / 30) % 2) txt("PRESS ENTER / TAP TO START", W / 2, 585, 16, "#5ef2ff", "center", 10);
  drawParts();
}
function drawParts() { for (const q of parts) { ctx.globalAlpha = Math.min(1, q.life / 30); ctx.fillStyle = q.col; ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3); } ctx.globalAlpha = 1; }
function drawHeart(x, y) { ctx.beginPath(); ctx.moveTo(x, y + 5); ctx.bezierCurveTo(x - 9, y - 2, x - 5, y - 9, x, y - 4); ctx.bezierCurveTo(x + 5, y - 9, x + 9, y - 2, x, y + 5); ctx.fill(); }

// ---------- loop: fixed 60 steps per second ----------
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(250, now - last); last = now;
  while (acc >= STEP) { update(); acc -= STEP; }
  render(); requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
