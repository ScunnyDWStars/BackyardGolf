// Headless play-test: loads the game, plays the hole with scripted mouse swings, and
// saves screenshots. Usage: node scripts/playtest.mjs <baseUrl> <outDir> [query]
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
    return { phase: s.phase, strokes: s.strokes, lie: s.lie, toPin: s.distanceToPin, club: s.club.id, carry: s.carries.get(s.club.id), puttRange: s.puttRange };
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

let shot = 0;
for (; shot < 10; shot++) {
  const s = await state();
  if (s.phase === "holed") break;
  const power = s.club === "PT" ? Math.min(1, (s.toPin * 1.08 + 0.3) / s.puttRange) : Math.min(1, s.toPin / ((s.carry ?? 100) + 8));
  await swing(power);
  await page.waitForTimeout(shot === 0 ? 1800 : 600);
  if (shot === 0) await page.screenshot({ path: `${out}/02-flight.png` });
  await page.waitForFunction(() => window.__game.session.phase !== "flight", null, { timeout: 90_000 });
  await page.waitForTimeout(1800);
  const after = await state();
  console.log(`shot ${shot + 1}: ${s.club} power ${power.toFixed(2)} -> ${after.lie}, ${after.toPin.toFixed(1)} m to pin, strokes ${after.strokes}, ${after.phase}`);
  await page.screenshot({ path: `${out}/03-shot${shot + 1}.png` });
}
const final = await state();
console.log("final", JSON.stringify(final));
console.log("errors", JSON.stringify(errors));
await browser.close();
process.exit(final.phase === "holed" && errors.length === 0 ? 0 : 1);
