// Sample elevation from AWS Terrain Tiles (Terrarium PNG encoding, no API key needed).
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { LatLon } from "../src/geo/projection";
import { lonLatToTile, terrariumHeight } from "../src/course/osm";

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

export async function makeTerrariumSampler(points: LatLon[], zoom = 15, cacheDir = ".cache/terrarium") {
  mkdirSync(cacheDir, { recursive: true });
  const tiles = new Map<string, PNG>();
  const need = new Set<string>();
  for (const p of points) {
    const t = lonLatToTile(p, zoom);
    need.add(`${Math.floor(t.x)}/${Math.floor(t.y)}`);
  }
  for (const key of need) {
    const file = join(cacheDir, `${zoom}-${key.replace("/", "-")}.png`);
    if (!existsSync(file)) {
      const res = await fetch(`${TILE_URL}/${zoom}/${key}.png`);
      if (!res.ok) throw new Error(`terrarium ${zoom}/${key}: HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    tiles.set(key, PNG.sync.read(readFileSync(file)));
  }
  const px = (tx: number, ty: number, x: number, y: number) => {
    const png = tiles.get(`${tx}/${ty}`);
    if (!png) throw new Error(`tile ${tx}/${ty} not loaded`);
    const i = (Math.min(255, Math.max(0, y)) * png.width + Math.min(255, Math.max(0, x))) * 4;
    return terrariumHeight(png.data[i], png.data[i + 1], png.data[i + 2]);
  };
  // Bilinear sample within a tile (edges clamp; good enough at golf-hole scale).
  return (p: LatLon): number => {
    const t = lonLatToTile(p, zoom);
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const fx = (t.x - tx) * 256 - 0.5;
    const fy = (t.y - ty) * 256 - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const ax = fx - x0;
    const ay = fy - y0;
    const top = px(tx, ty, x0, y0) * (1 - ax) + px(tx, ty, x0 + 1, y0) * ax;
    const bottom = px(tx, ty, x0, y0 + 1) * (1 - ax) + px(tx, ty, x0 + 1, y0 + 1) * ax;
    return top * (1 - ay) + bottom * ay;
  };
}
