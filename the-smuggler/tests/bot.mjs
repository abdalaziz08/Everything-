// Test-only dodging bot (a port of the original tests/bot_playtest.py lookahead bot).
// Given the game state, it returns one frame of input: [qx, qy, focus].
import { W, H, Q, MAX_MOVE, MAX_FOCUS } from "../public/sim.js";

const MOVES = [];
for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const f of [0, 1]) {
  const m = f ? MAX_FOCUS : MAX_MOVE, d = dx && dy ? Math.SQRT1_2 : 1;
  let qx = Math.round(dx * m * d), qy = Math.round(dy * m * d);
  while (qx * qx + qy * qy > m * m) { qx -= Math.sign(qx); qy -= Math.sign(qy); }
  MOVES.push([qx, qy, f]);
}

export function botInput(S, horizon = 14) {
  const p = S.player, boss = S.boss;
  if (S.state !== "fight" && S.state !== "phase" && S.state !== "intro") return [0, 0, 0];
  let best = MOVES[0], bs = Infinity;
  for (const mv of MOVES) {
    const vx = mv[0] / Q, vy = mv[1] / Q;
    let score = 0;
    for (let k = 1; k <= horizon; k++) {
      const px = Math.max(10, Math.min(W - 10, p.x + vx * k)), py = Math.max(20, Math.min(H - 14, p.y + vy * k));
      const wk = horizon + 1 - k;
      for (const b of S.eb) {
        const bx = b.x + b.vx * k, by = b.y + b.vy * k;
        const d = Math.hypot(bx - px, by - py) - (b.r * 0.8 + p.r);
        if (d < 0) score += wk * 1000; else if (d < 12) score += (12 - d) * wk * 2;
      }
      for (const L of S.lasers) if (L.t + k > L.warn - 4 && L.t + k <= L.warn + L.on && Math.abs(px - L.x) < L.w / 2 + 5) score += wk * 800;
      const bdx = px - boss.x, bdy = py - boss.y;
      if (Math.hypot(bdx, bdy) < boss.r + 20) score += wk * 500;
    }
    const fx = p.x + vx * 6, fy = p.y + vy * 6;
    score += Math.abs(fx - boss.x) * 0.15 + Math.abs(fy - 540) * 0.1;
    if (score < bs) { bs = score; best = mv; }
  }
  return best;
}
