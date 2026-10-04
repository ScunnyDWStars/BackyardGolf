// Print download links for a course's OpenStreetMap golf data (run them in a browser, then
// Export → "raw OSM data" and bake with scripts/bake-course.ts).
//   npx tsx scripts/course-request.ts "<course name>" <lat> <lon> [radiusKm]
// The query avoids quotes and regexes: overpass-api.de's firewall rejects some of those.
export {};

const [name, latArg, lonArg, kmArg] = process.argv.slice(2);
if (!name || !latArg || !lonArg) {
  console.error('usage: course-request.ts "<course name>" <lat> <lon> [radiusKm]');
  process.exit(2);
}
const lat = Number(latArg);
const lon = Number(lonArg);
const km = Number(kmArg ?? 1.6);
const dLat = km / 111.32;
const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
const box = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(4)).join(",");
const query =
  `[out:json][timeout:120][bbox:${box}];` +
  "(way[leisure=golf_course];relation[leisure=golf_course];way[golf];relation[golf];node[golf];" +
  "way[natural=water];way[natural=wood];way[natural=scrub];way[natural=sand];way[landuse=forest];" +
  "node[natural=tree];way[natural=tree_row];);out geom;";
const turbo = `https://overpass-turbo.eu/?Q=${encodeURIComponent(query)}&C=${lat};${lon};15&R`;
console.log(`${name}\n  overpass-turbo (runs automatically, then Export → raw OSM data):\n  ${turbo}\n\n  raw query:\n  ${query}\n`);
