// Fetch OpenStreetMap golf data from Overpass.
//   npx tsx scripts/fetch-osm.ts nearby <lat> <lon> [radiusKm]       list golf courses
//   npx tsx scripts/fetch-osm.ts course <way|relation> <id> <out.json>  golf features in a course
// Overpass is public infrastructure: keep requests small and cache the results.
import { writeFileSync } from "node:fs";

const OVERPASS = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

async function overpass(query: string) {
  const res = await fetch(OVERPASS, { method: "POST", body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ elements: { type: string; id: number; tags?: Record<string, string>; center?: { lat: number; lon: number } }[] }>;
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "nearby") {
  const [lat, lon, km = "25"] = args.map(Number);
  const r = Number(km) * 1000;
  const data = await overpass(`[out:json][timeout:60];
    (way["leisure"="golf_course"](around:${r},${lat},${lon});
     relation["leisure"="golf_course"](around:${r},${lat},${lon}););
    out tags center;`);
  for (const e of data.elements)
    console.log(`${e.type}/${e.id}\t${e.tags?.name ?? "(unnamed)"}\t${e.center?.lat.toFixed(5)},${e.center?.lon.toFixed(5)}`);
} else if (mode === "course") {
  const [kind, id, out = "course-osm.json"] = args;
  if (kind !== "way" && kind !== "relation") throw new Error("course <way|relation> <id> <out.json>");
  const data = await overpass(`[out:json][timeout:120];
    ${kind}(${Number(id)});
    out geom;
    map_to_area->.course;
    (way["golf"](area.course); relation["golf"](area.course); way["natural"="water"](area.course););
    out geom;`);
  writeFileSync(out, JSON.stringify(data));
  console.log(`saved ${data.elements.length} elements to ${out}`);
} else {
  console.error("usage: fetch-osm.ts nearby <lat> <lon> [km] | course <way|relation> <id> <out.json>");
  process.exit(2);
}
