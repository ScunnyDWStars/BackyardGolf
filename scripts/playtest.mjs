// Headless play-test: loads the game, plays the round's holes with scripted mouse swings,
// checks the scorecard flow, and saves screenshots.
// Usage: node scripts/playtest.mjs <baseUrl> <outDir> [query] [maxHoles]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const [base = "http://localhost:5173/", out = "playtest-out", query = "wind=0&flyover=0", maxHoles = "99"] = process.argv.slice(2);
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

/** 3-click: start, stop at the meter's ⚑ target mark, then stop in the accuracy zone. */
async function threeClick() {
  await page.waitForFunction(() => window.__game.meterTarget !== null, null, { timeout: 30_000 });
  await page.waitForTimeout(400); // let the solver settle on the final aim
  const target = await page.evaluate(() => window.__game.meterTarget);
  await page.keyboard.press(" ");
  // The marker moves in frame-sized steps; stop half a step early on average.
  await page.waitForFunction((t) => { const m = window.__game.meter; return m.phase !== "rising" || m.marker >= t - 0.02; }, target, { timeout: 120_000, polling: "raf" });
  await page.keyboard.press(" ");
  await page.waitForFunction(() => { const m = window.__game.meter; return m.phase !== "returning" || m.marker <= 0.025; }, null, { timeout: 120_000, polling: "raf" });
  await page.keyboard.press(" ");
  return target;
}

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
const holeCount = Math.min(Number(maxHoles), await page.evaluate(() => window.__game.round.course.holes.length));
let shot = 0;
for (let hole = 0; hole < holeCount; hole++) {
  for (let n = 0; n < 12; n++, shot++) {
    const s = await state();
    if (s.phase === "holed") break;
    const meterShown = await page.evaluate(() => !document.querySelector(".tc-meter").hidden);
    let power;
    if (meterShown) {
      power = await threeClick();
    } else {
      power = Math.min(1, s.toPin / ((s.carry ?? 100) + 8));
      await swing(power);
    }
    await page.waitForTimeout(shot === 0 ? 1800 : 600);
    if (shot === 0) await page.screenshot({ path: `${out}/02-flight.png` });
    // Skip the rest of the flight (the game's Space / ⏭ action) so slow software rendering
    // doesn't stretch each shot into minutes.
    await page.keyboard.press(" ");
    await page.waitForFunction(() => window.__game.session.phase !== "flight", null, { timeout: 90_000 });
    await page.waitForTimeout(1800);
    const after = await state();
    console.log(`hole ${after.hole} shot ${n + 1}: ${s.club} ${meterShown ? "3-click" : "analog"} power ${power.toFixed(2)} -> ${after.lie}, ${after.toPin.toFixed(1)} m to pin, strokes ${after.strokes}, ${after.phase}`);
    await page.screenshot({ path: `${out}/03-h${after.hole}-shot${n + 1}.png` });
  }
  await page.waitForSelector("[data-k=scorecard]:not([hidden])", { timeout: 20_000 });
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
const scored = final.scores.filter((x) => x !== null).length;
process.exit(final.phase === "holed" && scored >= holeCount && realErrors.length === 0 ? 0 : 1);
