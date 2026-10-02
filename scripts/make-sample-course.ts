// Write the synthetic sample course as Overpass JSON (for scripts/bake-course.ts).
//   npx tsx scripts/make-sample-course.ts <out-osm.json>
import { writeFileSync } from "node:fs";
import { sampleCourseOsm } from "../tests/sampleOsm";

const out = process.argv[2] ?? "sample-osm.json";
writeFileSync(out, JSON.stringify(sampleCourseOsm()));
console.log(`wrote ${out}`);
