// Bake one hole from Overpass golf data + Terrarium elevation into game CourseData.
//   npx tsx scripts/bake-course.ts <osm.json> <holeNumber> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { bakeHoleFromOsm, type OsmElement } from "../src/course/osm";
import { makeProjection } from "../src/geo/projection";
import { makeTerrariumSampler } from "./terrarium";

const [input, holeArg, out] = process.argv.slice(2);
if (!input || !holeArg || !out) {
  console.error("usage: bake-course.ts <osm.json> <holeNumber> <out.json>");
  process.exit(2);
}
const elements: OsmElement[] = JSON.parse(readFileSync(input, "utf8")).elements;
const hole = Number(holeArg);

// First pass with flat ground to learn the area, then sample real heights for it.
const flat = bakeHoleFromOsm(elements, () => 0, { hole });
const proj = makeProjection(flat.origin!);
const hf = flat.heightfield;
const corners = [
  proj.toLatLon(hf.originX, hf.originZ),
  proj.toLatLon(hf.originX + (hf.cols - 1) * hf.cellSize, hf.originZ),
  proj.toLatLon(hf.originX, hf.originZ + (hf.rows - 1) * hf.cellSize),
  proj.toLatLon(hf.originX + (hf.cols - 1) * hf.cellSize, hf.originZ + (hf.rows - 1) * hf.cellSize),
];
const heightAt = await makeTerrariumSampler(corners);
const course = bakeHoleFromOsm(elements, heightAt, { hole });
writeFileSync(out, JSON.stringify(course));
const h = course.heightfield.heights;
console.log(`hole ${hole}: par ${course.holes[0].par}, ${course.holes[0].lengthYards} yds, ${course.holes[0].areas.length} areas, ` +
  `relief ${Math.min(...h).toFixed(1)}..${Math.max(...h).toFixed(1)} m -> ${out}`);
