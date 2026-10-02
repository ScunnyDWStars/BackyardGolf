// Attach a captured splat hole (one-hole course file with splat alignment) to a full course.
//   npx tsx scripts/attach-splat.ts <course.json> <captured-hole.json> <holeNumber> <out.json> [splatUrl]
import { readFileSync, writeFileSync } from "node:fs";
import { attachSplatHole } from "../src/course/attachSplat";

const [coursePath, capturedPath, hole, out, splatUrl] = process.argv.slice(2);
if (!coursePath || !capturedPath || !hole || !out) {
  console.error("usage: attach-splat.ts <course.json> <captured-hole.json> <holeNumber> <out.json> [splatUrl]");
  process.exit(2);
}
const { course, transform } = attachSplatHole(
  JSON.parse(readFileSync(coursePath, "utf8")),
  JSON.parse(readFileSync(capturedPath, "utf8")),
  Number(hole),
  { splatUrl },
);
writeFileSync(out, JSON.stringify(course));
console.log(
  `hole ${hole}: scale ${transform.scale.toFixed(3)} (capture scale was ${((transform.scale - 1) * 100).toFixed(1)}% off), ` +
    `rotation ${((transform.angle * 180) / Math.PI).toFixed(1)} deg -> ${out}`,
);
