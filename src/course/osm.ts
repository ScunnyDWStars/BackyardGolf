import { type LatLon, makeProjection } from "../geo/projection";
import { v3 } from "../math/vec3";
import type { CourseData, HoleData, Lie, Polygon2 } from "./types";

/** Minimal Overpass JSON (`out geom;`) element shapes. */
export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

/** OSM golf tagging (https://wiki.openstreetmap.org/wiki/Key:golf) to game lies. */
export function lieForTags(tags: Record<string, string> = {}): Lie | null {
  switch (tags.golf) {
    case "fairway":
      return "fairway";
    case "green":
      return "green";
    case "tee":
      return "tee";
    case "bunker":
      return "bunker";
    case "water_hazard":
    case "lateral_water_hazard":
      return "water";
    case "rough":
      return "rough";
  }
  if (tags.natural === "water" || tags.water) return "water";
  if (tags.natural === "sand") return "bunker";
  return null;
}

export type HeightSampler = (p: LatLon) => number;

export interface BakeOptions {
  /** Hole number to bake (the `ref` tag of the golf=hole way). */
  hole: number;
  /** Metres of terrain around the hole. */
  margin?: number;
  cellSize?: number;
  courseName?: string;
}

function centroid(points: { lat: number; lon: number }[]): LatLon {
  const n = points.length;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lon: points.reduce((s, p) => s + p.lon, 0) / n,
  };
}

/** Convert Overpass golf features for one hole into the game's CourseData. Heights are
 * sampled through `heightAt` (e.g. Terrarium DEM tiles) relative to the tee. */
export function bakeHoleFromOsm(elements: OsmElement[], heightAt: HeightSampler, opts: BakeOptions): CourseData {
  const holeWay = elements.find((e) => e.tags?.golf === "hole" && Number(e.tags.ref) === opts.hole && e.geometry);
  if (!holeWay?.geometry || holeWay.geometry.length < 2) throw new Error(`no golf=hole way with ref=${opts.hole}`);

  const line = holeWay.geometry;
  const origin = line[0];
  const proj = makeProjection(origin);
  const toXZ = (p: LatLon): [number, number] => {
    const { x, z } = proj.toLocal(p);
    return [Math.round(x * 100) / 100, Math.round(z * 100) / 100];
  };
  const centerline = line.map(toXZ);

  const margin = opts.margin ?? 120;
  const xs = centerline.map((p) => p[0]);
  const zs = centerline.map((p) => p[1]);
  const minX = Math.min(...xs) - margin;
  const maxX = Math.max(...xs) + margin;
  const minZ = Math.min(...zs) - margin;
  const maxZ = Math.max(...zs) + margin;
  const inBox = ([x, z]: [number, number]) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;

  const areas: { lie: Lie; polygon: Polygon2 }[] = [];
  for (const e of elements) {
    const lie = lieForTags(e.tags);
    if (!lie) continue;
    const rings = e.geometry ? [e.geometry] : (e.members ?? []).filter((m) => m.role !== "inner" && m.geometry).map((m) => m.geometry!);
    for (const ring of rings) {
      if (ring.length < 3) continue;
      const poly = ring.map(toXZ);
      if (inBox(toXZ(centroid(ring)))) areas.push({ lie, polygon: poly });
    }
  }

  const boundary = elements.find((e) => e.tags?.leisure === "golf_course" && e.geometry);
  const bounds: Polygon2 = boundary?.geometry
    ? boundary.geometry.map(toXZ)
    : [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];

  const cell = opts.cellSize ?? 5;
  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxZ - minZ) / cell) + 1;
  const base = heightAt(origin);
  const heights: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ll = proj.toLatLon(minX + c * cell, minZ + r * cell);
      heights.push(Math.round((heightAt(ll) - base) * 100) / 100);
    }
  }
  const hAt = (x: number, z: number) => {
    const c = Math.min(cols - 1, Math.max(0, Math.round((x - minX) / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.round((z - minZ) / cell)));
    return heights[r * cols + c];
  };

  const tee = centerline[0];
  const pin = centerline[centerline.length - 1];
  const lengthM = centerline.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - centerline[i][0], p[1] - centerline[i][1]), 0);
  const hole: HoleData = {
    number: opts.hole,
    par: Number(holeWay.tags?.par ?? 4),
    lengthYards: Math.round(lengthM * 1.09361),
    tee: v3(tee[0], hAt(...tee), tee[1]),
    pin: v3(pin[0], hAt(...pin), pin[1]),
    centerline,
    areas,
  };
  return {
    name: opts.courseName ?? boundary?.tags?.name ?? "Unnamed course",
    attribution: ["Course layout © OpenStreetMap contributors (ODbL)", "Elevation: AWS Terrain Tiles (Mapzen Terrarium)"],
    origin: { lat: origin.lat, lon: origin.lon },
    heightfield: { originX: minX, originZ: minZ, cellSize: cell, cols, rows, heights },
    bounds,
    holes: [hole],
  };
}

/** Decode one Terrarium-encoded elevation pixel (metres above sea level). */
export const terrariumHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** Web-Mercator tile coordinates (fractional) for a lat/lon at zoom z. */
export function lonLatToTile(p: LatLon, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lat = (p.lat * Math.PI) / 180;
  return {
    x: ((p.lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n,
  };
}
