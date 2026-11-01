// THE SMUGGLER — "The Border" game logic. SERVER ONLY (never served to the browser).
//
// You are the border guard. Travelers arrive one by one, each with visible traits. A hidden rule
// decides who is a smuggler. You STAMP (pass) or SEARCH. The server only tells you right/wrong.
// The rule is never sent to the client and never appears in any served file, so the only way
// through is to *infer* it — human inductive reasoning, which automated solvers are weak at,
// especially because many rules are relational (compare two traits) or temporal (compare to the
// previous traveler), and you only get a few mistakes before the session ends.

export const COLORS = ["crimson", "teal", "gold", "violet"];
export const CRATES = ["none", "sack", "box", "barrel"]; // weight = index
export const HATS = ["cap", "tophat", "hood"];
export const STAMPS = ["none", "crimson", "teal", "gold", "violet"]; // none = unstamped
export const BADGES = ["anchor", "feather", "key", "skull"];
const crateWeight = c => CRATES.indexOf(c);
const WARM = new Set(["crimson", "gold"]);           // warm vs cool colors (human-intuitive grouping)
const temp = col => col === "none" ? "none" : WARM.has(col) ? "warm" : "cool";

// ---------- deterministic PRNG from a key (sfc32 seeded by 16 key bytes) ----------
function rngFromBytes(bytes) {
  let a = 0, b = 0, c = 0, d = 0;
  for (let i = 0; i < 4; i++) a = (a << 8 | bytes[i]) >>> 0;
  for (let i = 4; i < 8; i++) b = (b << 8 | bytes[i]) >>> 0;
  for (let i = 8; i < 12; i++) c = (c << 8 | bytes[i]) >>> 0;
  for (let i = 12; i < 16; i++) d = (d << 8 | bytes[i]) >>> 0;
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (a + b | 0) + d | 0; d = d + 1 | 0; a = b ^ b >>> 9; b = c + (c << 3) | 0; c = c << 21 | c >>> 11; c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
}
// A sub-stream for a given label, so rule-derivation and each traveler are independent & reproducible.
function subRng(keyBytes, tag, index) {
  const seed = new Uint8Array(16);
  let h = 2166136261 >>> 0;
  const mix = s => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; };
  mix(tag + ":" + index + ":");
  for (let i = 0; i < 16; i++) { h = Math.imul(h ^ keyBytes[i % keyBytes.length], 16777619) >>> 0; seed[i] = (h >>> (i % 4 * 8)) & 255; }
  return rngFromBytes(seed);
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------- travelers ----------
export function makeTraveler(keyBytes, index) {
  const r = subRng(keyBytes, "traveler", index);
  return { coat: pick(r, COLORS), crate: pick(r, CRATES), hat: pick(r, HATS), stamp: pick(r, STAMPS), badge: pick(r, BADGES) };
}

// ---------- the hidden rule ----------
// Each rule is a predicate (cur, prev) -> smuggler? "prev" is the previous traveler (for temporal rules).
const RULE_FAMILY = [
  // simple (fewer of these, so the game leans on the harder kinds)
  { kind: "eq", weight: 1, make: r => { const f = pick(r, ["coat", "crate", "hat", "stamp", "badge"]); const v = pick(r, domain(f)); return { desc: `${f} is ${v}`, test: c => c[f] === v }; } },
  { kind: "neq", weight: 1, make: r => { const f = pick(r, ["coat", "crate", "hat", "badge"]); const v = pick(r, domain(f)); return { desc: `${f} is not ${v}`, test: c => c[f] !== v }; } },
  { kind: "in", weight: 1, make: r => { const f = pick(r, ["coat", "crate", "badge"]); const d = domain(f).slice(); shuffle(r, d); const set = d.slice(0, 2); return { desc: `${f} in {${set.join(",")}}`, test: c => set.includes(c[f]) }; } },
  { kind: "and", weight: 1, make: r => { const [f1, f2] = pick2(r, ["coat", "crate", "hat", "stamp", "badge"]); const v1 = pick(r, domain(f1)), v2 = pick(r, domain(f2)); return { desc: `${f1}=${v1} AND ${f2}=${v2}`, test: c => c[f1] === v1 && c[f2] === v2 }; } },
  { kind: "or", weight: 1, make: r => { const [f1, f2] = pick2(r, ["coat", "crate", "hat", "stamp", "badge"]); const v1 = pick(r, domain(f1)), v2 = pick(r, domain(f2)); return { desc: `${f1}=${v1} OR ${f2}=${v2}`, test: c => c[f1] === v1 || c[f2] === v2 }; } },
  // relational — harder for "extract features -> simple classifier"
  { kind: "sameColor", weight: 2, make: () => ({ desc: "coat color matches stamp color", test: c => c.stamp !== "none" && c.coat === c.stamp }) },
  { kind: "diffColor", weight: 2, make: () => ({ desc: "stamped, but stamp color differs from coat", test: c => c.stamp !== "none" && c.coat !== c.stamp }) },
  { kind: "unstampedCargo", weight: 2, make: () => ({ desc: "carrying cargo but unstamped", test: c => c.stamp === "none" && c.crate !== "none" }) },
  { kind: "sameTemp", weight: 2, make: () => ({ desc: "coat and stamp are the same warmth", test: c => c.stamp !== "none" && temp(c.coat) === temp(c.stamp) }) },
  { kind: "xorStampCargo", weight: 2, make: () => ({ desc: "stamped or carrying, but not both", test: c => (c.stamp !== "none") !== (c.crate !== "none") }) },
  // temporal — hardest for stateless perception; needs working memory
  { kind: "heavier", weight: 2, make: () => ({ desc: "heavier cargo than the previous traveler", test: (c, p) => crateWeight(c.crate) > crateWeight(p.crate) }) },
  { kind: "lighter", weight: 2, make: () => ({ desc: "lighter cargo than the previous traveler", test: (c, p) => crateWeight(c.crate) < crateWeight(p.crate) }) },
  { kind: "sameCoatPrev", weight: 2, make: () => ({ desc: "coat color same as previous traveler", test: (c, p) => c.coat === p.coat }) },
  { kind: "sameHatPrev", weight: 2, make: () => ({ desc: "same hat as the previous traveler", test: (c, p) => c.hat === p.hat }) },
  { kind: "sameBadgePrev", weight: 2, make: () => ({ desc: "same badge as the previous traveler", test: (c, p) => c.badge === p.badge }) },
];
function domain(f) { return f === "coat" ? COLORS : f === "crate" ? CRATES : f === "hat" ? HATS : f === "stamp" ? STAMPS : BADGES; }
function shuffle(r, a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } }
function pick2(r, arr) { const a = arr.slice(); shuffle(r, a); return [a[0], a[1]]; }

// Derive the session's rule, re-rolling until its smuggler-rate over random travelers is balanced,
// so neither "always pass" nor "always search" is close to right.
export function deriveRule(keyBytes) {
  const r = subRng(keyBytes, "rule", 0);
  const total = RULE_FAMILY.reduce((s, x) => s + x.weight, 0);
  for (let attempt = 0; attempt < 40; attempt++) {
    let roll = r() * total, chosen = RULE_FAMILY[0];
    for (const x of RULE_FAMILY) { roll -= x.weight; if (roll <= 0) { chosen = x; break; } }
    const rule = chosen.make(r);
    rule.kind = chosen.kind;
    if (balanced(rule)) return rule;
  }
  return { kind: "eq", desc: "crate is barrel", test: c => c.crate === "barrel" };
}
const PREV_SAMPLES = [
  { coat: "teal", crate: "box", hat: "cap", stamp: "none", badge: "key" },
  { coat: "gold", crate: "barrel", hat: "hood", stamp: "crimson", badge: "skull" },
  { coat: "violet", crate: "none", hat: "tophat", stamp: "teal", badge: "anchor" },
];
function balanced(rule) {
  let smug = 0, n = 0;
  for (const coat of COLORS) for (const crate of CRATES) for (const hat of HATS) for (const stamp of STAMPS) for (const badge of BADGES)
    for (const pc of PREV_SAMPLES) { n++; if (rule.test({ coat, crate, hat, stamp, badge }, pc)) smug++; }
  const rate = smug / n;
  return rate >= 0.34 && rate <= 0.66;
}

export function isSmuggler(rule, cur, prev) { return !!rule.test(cur, prev); }
