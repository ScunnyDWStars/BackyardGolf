// Headless play-test: loads the game, plays every hole of the round with scripted mouse
// swings, checks the scorecard flow, and saves screenshots. Usage: node scripts/playtest.mjs <baseUrl> <outDir> [query]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const [base = "http://localhost:5173/", out = "playtest-out", query = "wind=0&flyover=0"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${base}?${query}`);
await page.waitForSelector("body[data-ready=true]", { timeout: 60_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/01-address.png` });

const state = () =>
  page.evaluate(() => {
    const s = window.__game.session;
    return { hole: s.hole.number, phase: s.phase, strokes: s.strokes, lie: s.lie, toPin: s.distanceToPin, club: s.club.id, carry: s.carries.get(s.club.id), puttRange: s.puttRange, scores: window.__game.round.scores };
  });

async function swing(power, driftPx = 0) {
  const full = Math.max(120, 720 * 0.28);
  const x = 640, y = 300;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const depth = full * power;
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x, y + (depth * i) / 12);
    await page.waitForTimeout(16);
  }
  // Two quick moves: the headless renderer is slow, and tempo is judged on stroke time.
  for (let i = 1; i <= 2; i++) await page.mouse.move(x + (driftPx * i) / 2, y + depth - ((depth + 20) * i) / 2);
  await page.mouse.up();
}

// Play every hole of the round: hole out, wait for the scorecard, take its primary action.
const holeCount = await page.evaluate(() => window.__game.round.course.holes.length);
let shot = 0;
for (let hole = 0; hole < holeCount; hole++) {
  for (let n = 0; n < 12; n++, shot++) {
    const s = await state();
    if (s.phase === "holed") break;
    const power = s.club === "PT" ? Math.min(1, (s.toPin * 1.08 + 0.3) / s.puttRange) : Math.min(1, s.toPin / ((s.carry ?? 100) + 8));
    await swing(power);
    await page.waitForTimeout(shot === 0 ? 1800 : 600);
    if (shot === 0) await page.screenshot({ path: `${out}/02-flight.png` });
    await page.waitForFunction(() => window.__game.session.phase !== "flight", null, { timeout: 90_000 });
    await page.waitForTimeout(1800);
    const after = await state();
    console.log(`hole ${after.hole} shot ${n + 1}: ${s.club} power ${power.toFixed(2)} -> ${after.lie}, ${after.toPin.toFixed(1)} m to pin, strokes ${after.strokes}, ${after.phase}`);
    await page.screenshot({ path: `${out}/03-h${after.hole}-shot${n + 1}.png` });
  }
  await page.waitForSelector(".scorecard:not([hidden])", { timeout: 20_000 });
  await page.screenshot({ path: `${out}/04-card-h${hole + 1}.png` });
  const label = await page.textContent(".card-actions button.primary");
  console.log(`scorecard after hole ${hole + 1}: "${label}"`);
  if (hole + 1 < holeCount) {
    await page.click(".card-actions button.primary");
    await page.waitForTimeout(1500);
    await page.keyboard.press(" "); // skip the flyover
    await page.waitForTimeout(1500);
  }
}
const final = await state();
console.log("final", JSON.stringify(final));
console.log("errors", JSON.stringify(errors));
await browser.close();
const realErrors = errors.filter((e) => !e.includes("ERR_CERT")); // sandbox blocks Google Fonts
process.exit(final.phase === "holed" && final.scores.every((x) => x !== null) && realErrors.length === 0 ? 0 : 1);
