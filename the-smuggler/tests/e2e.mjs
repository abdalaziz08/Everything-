// End-to-end test in a real browser (Playwright + Chromium), in real time (~2-3 minutes).
//   SMUGGLER_SECRET=... node tests/e2e.mjs [expected_trophy.png]
// 1. a bot plays the real page by pressing keys, wins, and the trophy from the server is shown
// 2. a cheating page (boss HP edited to 6 in the browser) "wins" fast and the server rejects it
// The bot is injected by the test only; nothing like it ships in public/.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3911, BASE = `http://localhost:${PORT}`;
let failed = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  (" + extra + ")" : "")); if (!ok) failed++; };

if (!process.env.SMUGGLER_SECRET) { console.error("set SMUGGLER_SECRET"); process.exit(1); }
const server = spawn("node", [join(ROOT, "server/node.js")], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise(res => server.stdout.once("data", res));

const botSrc = (await readFile(join(ROOT, "tests/bot.mjs"), "utf8")).replace("../public/sim.js", "/sim.js");
const HOOK = `
  if (S && mode === "play") { const [bx, by, bf] = __botInput(S);
    keys.ArrowLeft = bx < 0; keys.ArrowRight = bx > 0; keys.ArrowUp = by < 0; keys.ArrowDown = by > 0; keys.ShiftLeft = bf === 1; }
  tick++;`;

async function page(browser, { cheat }) {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 680 } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", e => errors.push(String(e)));
  await pg.route("**/__bot.js", r => r.fulfill({ contentType: "text/javascript", body: botSrc }));
  await pg.route("**/game.js", async r => {
    let js = await (await r.fetch()).text();
    js = 'import { botInput as __botInput } from "/__bot.js";\n' + js.replace("function update() {\n  tick++;", "function update() {" + HOOK);
    if (!js.includes("__botInput(S)")) throw new Error("hook not injected");
    r.fulfill({ contentType: "text/javascript", body: js });
  });
  if (cheat) await pg.route("**/sim.js", async r => {
    const js = (await (await r.fetch()).text()).replace(/hp: (420|490|630)/g, "hp: 6");
    r.fulfill({ contentType: "text/javascript", body: js });
  });
  await pg.goto(BASE);
  await pg.waitForTimeout(800);
  await pg.keyboard.press("Enter");
  return { pg, errors };
}

const browser = await chromium.launch({ args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });

// 2 first (fast): the cheater
{
  const { pg, errors } = await page(browser, { cheat: true });
  await pg.waitForSelector("#win.on h1:text-matches('REJECTED|VICTORY')", { timeout: 120000 });
  const h1 = await pg.textContent("#win h1"), msg = await pg.textContent("#msg");
  check("cheating page (boss HP 6) is rejected by the server", h1 === "REJECTED", msg);
  check("cheating page gets no image", !(await pg.getAttribute("#trophy", "src")));
  check("no page errors (cheat run)", errors.length === 0, errors.join("; "));
  await pg.screenshot({ path: "/tmp/smuggler_e2e_rejected.png" });
}

// 1: the real game, played by the bot in real time
{
  const t0 = Date.now();
  const { pg, errors } = await page(browser, { cheat: false });
  let lastLog = 0;
  for (;;) {
    if (await pg.isVisible("#win.on")) {
      const h1 = await pg.textContent("#win h1");
      if (h1 !== "VERIFYING") break;
    }
    if (Date.now() - t0 > 300000) break;
    if (Date.now() - lastLog > 20000) { lastLog = Date.now(); console.log(`  ...playing ${Math.round((Date.now() - t0) / 1000)} s`); }
    await pg.waitForTimeout(1000);
  }
  const h1 = await pg.textContent("#win h1"), msg = await pg.textContent("#msg");
  check("real run by the bot gets VICTORY from the server", h1 === "VICTORY", `${h1}: ${msg}, ${Math.round((Date.now() - t0) / 1000)} s`);
  const png = await pg.evaluate(async () => {
    const src = document.getElementById("trophy").src;
    if (!src) return null;
    return Array.from(new Uint8Array(await (await fetch(src)).arrayBuffer()));
  });
  check("trophy image is shown", png && png[0] === 0x89 && png[1] === 0x50, png ? png.length + " bytes" : "none");
  if (process.argv[2] && png) {
    const want = createHash("sha256").update(await readFile(process.argv[2])).digest("hex");
    const got = createHash("sha256").update(Buffer.from(png)).digest("hex");
    check("trophy is byte-for-byte the original", want === got);
  }
  check("download button is shown", await pg.isVisible("#dl"));
  check("no page errors (real run)", errors.length === 0, errors.join("; "));
  await pg.screenshot({ path: "/tmp/smuggler_e2e_victory.png" });
}

// the server must not hand out its own files
for (const p of ["/server/trophy.js", "/server/app.js", "/../server/trophy.js", "/api/verify"]) {
  const r = await fetch(BASE + p);
  check(`GET ${p} gives nothing useful`, r.status >= 400, String(r.status));
}

await browser.close();
server.kill();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
