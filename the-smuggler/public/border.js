// THE SMUGGLER — "The Border", browser side.
// Shows each traveler, sends your SEARCH/PASS to the server, and reveals right/wrong so you can
// learn the hidden rule. The rule is never sent here — the page literally does not know who the
// smuggler is. Reach the streak before the slip-ups run out and the server hands over the trophy.

const COL = { crimson: "#d7334b", teal: "#2bb3a3", gold: "#e3b23c", violet: "#8b5cf6" };
const SKIN = "#d9a66b", DARK = "#1c1322";
const $ = id => document.getElementById(id);

let st = { token: null, at: 0, goal: 8, maxStrikes: 5, busy: false, over: false };

// ---------- drawing a traveler ----------
function hat(kind) {
  if (kind === "cap") return `<path d="M64 52 Q90 26 116 52 Z" fill="${DARK}"/><rect x="88" y="50" width="34" height="7" rx="3" fill="${DARK}"/>`;
  if (kind === "tophat") return `<rect x="72" y="18" width="36" height="34" rx="3" fill="${DARK}"/><rect x="60" y="50" width="60" height="8" rx="4" fill="${DARK}"/>`;
  return `<path d="M62 56 Q90 10 118 56 Q90 46 62 56 Z" fill="${DARK}"/>`; // hood
}
function crate(kind) {
  if (kind === "none") return `<circle cx="66" cy="150" r="6" fill="${SKIN}"/><circle cx="114" cy="150" r="6" fill="${SKIN}"/>`;
  if (kind === "sack") return `<path d="M74 150 Q72 186 90 186 Q108 186 106 150 Q98 142 90 142 Q82 142 74 150 Z" fill="#b98a55" stroke="#2a1a10" stroke-width="2"/><path d="M80 150 Q90 144 100 150" fill="none" stroke="#2a1a10" stroke-width="2"/>`;
  if (kind === "box") return `<rect x="70" y="150" width="40" height="36" rx="3" fill="#c08a4a" stroke="#2a1a10" stroke-width="2"/><path d="M90 150 V186 M70 168 H110" stroke="#e8c892" stroke-width="3"/>`;
  return `<rect x="70" y="148" width="40" height="40" rx="7" fill="#9a6b3a" stroke="#2a1a10" stroke-width="2"/><path d="M70 160 H110 M70 176 H110" stroke="#2a1a10" stroke-width="2"/>`; // barrel
}
function badgeGlyph(kind) {
  const s = `fill="none" stroke="#120a06" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"`;
  const g = { // drawn in a 0..18 box, translated onto the chest
    anchor: `<circle cx="9" cy="2.5" r="2.3" ${s}/><path d="M9 4.8 V16 M3 11 Q3 16 9 16 Q15 16 15 11 M5 8 H13" ${s}/>`,
    feather: `<path d="M15 3 Q6 5 4 15 M15 3 Q13 10 7 12 M15 3 Q14 7 10 8.5 M4 15 L7 12" ${s}/>`,
    key: `<circle cx="5" cy="6" r="3.2" ${s}/><path d="M7.3 8.3 L15 16 M12 13 L14 11 M13.5 14.5 L15.5 12.5" ${s}/>`,
    skull: `<path d="M4 7 Q4 1 9 1 Q14 1 14 7 Q14 10 12 11 L12 14 Q12 16 9 16 Q6 16 6 14 L6 11 Q4 10 4 7 Z" ${s}/><circle cx="7" cy="7" r="1.4" fill="#120a06"/><circle cx="11" cy="7" r="1.4" fill="#120a06"/>`,
  };
  return `<g transform="translate(99,96)">${g[kind] || ""}</g>`;
}
function stampSeal(stamp) {
  if (stamp === "none") return `<g transform="translate(59,96)" opacity=".8"><circle cx="9" cy="9" r="9" fill="none" stroke="#6a5a48" stroke-width="2" stroke-dasharray="3 3"/><path d="M4 4 L14 14" stroke="#6a5a48" stroke-width="2"/></g>`;
  const c = COL[stamp];
  return `<g transform="translate(59,96)"><circle cx="9" cy="9" r="9" fill="${c}" opacity=".3"/><circle cx="9" cy="9" r="9" fill="none" stroke="${c}" stroke-width="2.4"/><circle cx="9" cy="9" r="3.4" fill="${c}"/></g>`;
}
function svgTraveler(t) {
  const coat = COL[t.coat];
  return `<svg viewBox="0 0 180 200" width="100%" style="display:block">
    <ellipse cx="90" cy="192" rx="46" ry="7" fill="#000" opacity=".35"/>
    <line x1="66" y1="96" x2="66" y2="150" stroke="${coat}" stroke-width="9" stroke-linecap="round"/>
    <line x1="114" y1="96" x2="114" y2="150" stroke="${coat}" stroke-width="9" stroke-linecap="round"/>
    <rect x="56" y="82" width="68" height="86" rx="16" fill="${coat}" stroke="#120a06" stroke-width="2"/>
    <circle cx="90" cy="62" r="22" fill="${SKIN}" stroke="#120a06" stroke-width="2"/>
    ${hat(t.hat)}
    ${stampSeal(t.stamp)}
    ${badgeGlyph(t.badge)}
    ${crate(t.crate)}
  </svg>`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function traitList(t) {
  const sw = c => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:-1px;background:${COL[c]};margin-right:3px"></span>`;
  return [
    `coat <b>${sw(t.coat)}${cap(t.coat)}</b>`,
    `crate <b>${cap(t.crate)}</b>`,
    `hat <b>${cap(t.hat)}</b>`,
    `stamp <b>${t.stamp === "none" ? "None" : sw(t.stamp) + cap(t.stamp)}</b>`,
    `badge <b>${cap(t.badge)}</b>`,
  ].join(" · ");
}
function renderCard(which, t) {
  $(which + "Fig").innerHTML = svgTraveler(t);
  $(which + "Traits").innerHTML = traitList(t);
}

// ---------- meters ----------
function pips(el, n, on, cls) {
  let h = "";
  for (let i = 0; i < n; i++) h += `<div class="pip${i < on ? " on" : ""}"></div>`;
  el.innerHTML = h;
}
function meters(streak, strikes) {
  $("goalTxt").textContent = `${streak}/${st.goal}`;
  pips($("streakPips"), st.goal, streak);
  pips($("strikePips"), st.maxStrikes, strikes);
}

// ---------- flow ----------
function setButtons(on) { $("searchBtn").disabled = !on; $("passBtn").disabled = !on; }
function overlay(title, msg, { png, again } = {}) {
  $("ovTitle").textContent = title; $("ovMsg").textContent = msg;
  const img = $("trophy"), dl = $("dl");
  if (png) { const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: "image/png" })); img.src = url; dl.href = url; dl.hidden = false; }
  else { img.removeAttribute("src"); dl.hidden = true; }
  $("again").hidden = !again;
  $("overlay").classList.add("on");
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

function toBoss() { location.href = "index.html"; }

async function start() {
  $("overlay").classList.remove("on");
  st.over = false; st.busy = true; setButtons(false); $("net").textContent = ""; $("verdict").textContent = "";
  let pass = null;
  try { pass = sessionStorage.getItem("smuggler_pass"); } catch {}
  if (!pass) { lock("LOCKED", "BEAT THE SMUGGLER'S BOSS FIRST TO REACH THE BORDER."); return; }
  let j;
  try { j = await post("/api/s2/start", { pass }); } catch { $("net").textContent = "CAN'T REACH THE BORDER — RELOAD"; st.busy = false; return; }
  if (!j.token) { lock("LOCKED", (j.error || "beat the boss first").toUpperCase()); return; }
  // The pass is single-use: it is spent now. A new attempt means beating the boss again.
  try { sessionStorage.removeItem("smuggler_pass"); } catch {}
  st.token = j.token; st.at = j.at; st.goal = j.goal; st.maxStrikes = j.maxStrikes;
  renderCard("prev", j.prev); renderCard("cur", j.cur); meters(0, 0);
  st.busy = false; setButtons(true);
}
function lock(title, msg) {
  st.over = true; st.busy = false; setButtons(false);
  $("again").textContent = "TO THE BOSS";
  overlay(title, msg, { again: true });
}

async function decide(decision) {
  if (st.busy || st.over) return;
  st.busy = true; setButtons(false); $("net").textContent = ""; $("verdict").innerHTML = "";
  let j;
  try { j = await post("/api/s2/step", { token: st.token, at: st.at, decision }); }
  catch { $("net").textContent = "CONNECTION HICCUP — TAP AGAIN"; st.busy = false; setButtons(true); return; }
  if (j.error) {
    if (/sync|closed|over/.test(j.error)) { overlay("BOOTH CLOSED", j.error.toUpperCase(), { again: true }); st.over = true; }
    else $("net").textContent = j.error.toUpperCase();
    st.busy = false; return;
  }

  meters(j.streak, j.strikes);
  const wasSmug = j.actual;
  const verdict = $("verdict");
  verdict.innerHTML = j.correct
    ? `<span class="ok">✓ ${decision === "search" ? "CONTRABAND! Good catch." : "Clean. Waved through."}</span>`
    : `<span class="bad">✗ ${wasSmug ? "SMUGGLER SLIPPED THROUGH." : "You searched an innocent."}</span>`;

  await new Promise(r => setTimeout(r, j.done ? 500 : 820));

  if (j.won) { st.over = true; $("again").textContent = "PLAY AGAIN"; overlay("VICTORY", "THE SMUGGLER HAS FALLEN. YOUR TROPHY AWAITS.", { png: j.png, again: true }); return; }
  if (j.done) { st.over = true; $("again").textContent = "BACK TO THE BOSS"; overlay("SHIFT OVER", "TOO MANY SLIP-UPS. BEAT THE BOSS AGAIN FOR ANOTHER PASS.", { again: true }); return; }

  st.at = j.at; renderCard("prev", j.prev); renderCard("cur", j.cur);
  st.busy = false; setButtons(true);
}

// A stage-2 attempt is spent once started, so every retry goes back through the boss.
$("searchBtn").onclick = () => decide("search");
$("passBtn").onclick = () => decide("pass");
$("again").onclick = () => toBoss();
addEventListener("keydown", e => {
  if (st.over && (e.code === "Enter" || e.code === "Space")) { toBoss(); return; }
  if (st.over) return;
  if (e.code === "ArrowLeft" || e.code === "KeyS") decide("search");
  if (e.code === "ArrowRight" || e.code === "KeyP") decide("pass");
});

start();
