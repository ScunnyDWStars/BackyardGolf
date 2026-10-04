// Bake a course from Overpass golf data + Terrarium elevation into game CourseData.
//   npx tsx scripts/bake-course.ts <osm.json> <out.json> [holes, e.g. "2" or "1-9"] [--course "<name>"]
// --course picks one leisure=golf_course by name when the data covers several (e.g. St Andrews).
import { readFileSync, writeFileSync } from "node:fs";
import { bakeCourseFromOsm, type OsmElement } from "../src/course/osm";
import { makeProjection } from "../src/geo/projection";
import { makeTerrariumSampler } from "./terrarium";

const argv = process.argv.slice(2);
const courseFlag = argv.indexOf("--course");
const courseName = courseFlag >= 0 ? argv.splice(courseFlag, 2)[1] : undefined;
const [input, out, holesArg] = argv;
if (!input || !out) {
  console.error('usage: bake-course.ts <osm.json> <out.json> [holes, e.g. "2" or "1-9"]');
  process.exit(2);
}
const elements: OsmElement[] = JSON.parse(readFileSync(input, "utf8")).elements;
let holes: number[] | undefined;
if (holesArg) {
  const [a, b] = holesArg.split("-").map(Number);
  holes = Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
}

// First pass on flat ground to learn the extent, then sample real heights over it.
const flat = bakeCourseFromOsm(elements, () => 0, { holes, course: courseName });
const proj = makeProjection(flat.origin!);
const hf = flat.heightfield;
const samples = [];
for (let r = 0; r < hf.rows; r += 8)
  for (let c = 0; c < hf.cols; c += 8) samples.push(proj.toLatLon(hf.originX + c * hf.cellSize, hf.originZ + r * hf.cellSize));
samples.push(proj.toLatLon(hf.originX + (hf.cols - 1) * hf.cellSize, hf.originZ + (hf.rows - 1) * hf.cellSize));
const heightAt = await makeTerrariumSampler(samples);
const course = bakeCourseFromOsm(elements, heightAt, { holes, course: courseName });
writeFileSync(out, JSON.stringify(course));
const h = course.heightfield.heights;
const numbers = course.holes.map((x) => x.number);
const missing = Array.from({ length: Math.max(...numbers) }, (_, i) => i + 1).filter((n) => !numbers.includes(n));
const par = course.holes.reduce((a, x) => a + x.par, 0);
const yards = course.holes.reduce((a, x) => a + x.lengthYards, 0);
console.log(`total par ${par}, ${yards} yds${missing.length ? ` — MISSING hole lines for ${missing.join(", ")}` : ""}`);
console.log(
  `${course.name}: ${course.holes.length} holes (${course.holes.map((x) => `${x.number}:par ${x.par} ${x.lengthYards}yd`).join(", ")}), ` +
    `${course.areas?.length ?? 0} areas, ${course.features?.trees?.length ?? 0} trees, ${course.features?.woods?.length ?? 0} woods, ` +
    `relief ${Math.min(...h).toFixed(1)}..${Math.max(...h).toFixed(1)} m, ${hf.cols}x${hf.rows} cells -> ${out}`,
);
