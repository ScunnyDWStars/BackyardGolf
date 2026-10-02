import { type LatLon, makeProjection } from "../geo/projection";
import { v3 } from "../math/vec3";
import { pointInPolygon } from "./terrain";
import type { Area, CourseData, CourseFeatures, HoleData, Lie, Polygon2 } from "./types";

type LL = { lat: number; lon: number };

/** Minimal Overpass JSON (`out geom;`) element shapes. */
export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: LL[];
  members?: { type: string; role: string; geometry?: LL[] }[];
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

function woodKind(tags: Record<string, string> = {}): "wood" | "scrub" | null {
  if (tags.natural === "wood" || tags.landuse === "forest") return "wood";
  if (tags.natural === "scrub") return "scrub";
  return null;
}

export type HeightSampler = (p: LatLon) => number;

export interface BakeOptions {
  /** Holes to bake by number (the `ref` tag of golf=hole ways); default: all. */
  holes?: number[];
  /** Metres of terrain beyond the holes and the course boundary. */
  margin?: number;
  cellSize?: number;
  courseName?: string;
}

const same = (a: LL, b: LL) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;

/** Join a multipolygon's member ways into closed rings (OSM splits rings across ways). */
export function assembleRings(segments: LL[][]): LL[][] {
  const pending = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const rings: LL[][] = [];
  while (pending.length) {
    const ring = pending.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const s = pending[i];
        const end = ring[ring.length - 1];
        if (same(s[0], end)) ring.push(...s.slice(1));
        else if (same(s[s.length - 1], end)) ring.push(...[...s].reverse().slice(1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function outerRings(e: OsmElement): LL[][] {
  if (e.type === "way" && e.geometry && e.geometry.length >= 3) return [e.geometry];
  if (e.type === "relation" && e.members) {
    return assembleRings(e.members.filter((m) => m.role !== "inner" && m.geometry).map((m) => m.geometry!));
  }
  return [];
}

const polyLength = (pts: [number, number][]) =>
  pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

/**
 * Convert Overpass golf data into the game's CourseData: every golf=hole way becomes a hole
 * (tee = first node, pin = golf=pin node near the end or the last node), lie polygons and
 * woods become course-wide areas and features, and `heightAt` (e.g. Terrarium DEM tiles)
 * supplies the ground, which is then shaped like a built course: bunkers dug in, water
 * lowered below its banks, tee boxes levelled and raised.
 */
export function bakeCourseFromOsm(elements: OsmElement[], heightAt: HeightSampler, opts: BakeOptions = {}): CourseData {
  const holeWays = elements
    .filter((e) => e.tags?.golf === "hole" && e.geometry && e.geometry.length >= 2)
    .filter((e) => !opts.holes || opts.holes.includes(Number(e.tags!.ref)))
    .sort((a, b) => Number(a.tags!.ref) - Number(b.tags!.ref));
  if (holeWays.length === 0) {
    throw new Error(opts.holes ? `no golf=hole way with ref=${opts.holes.join(",")}` : "no golf=hole ways in the data");
  }

  const origin = holeWays[0].geometry![0];
  const proj = makeProjection(origin);
  const toXZ = (p: LL): [number, number] => {
    const { x, z } = proj.toLocal(p);
    return [Math.round(x * 100) / 100, Math.round(z * 100) / 100];
  };

  const lines = holeWays.map((w) => w.geometry!.map(toXZ));
  const boundaryEl = elements.find((e) => e.tags?.leisure === "golf_course" && outerRings(e).length);
  const boundaryRing = boundaryEl ? outerRings(boundaryEl)[0].map(toXZ) : null;

  // Terrain extent: around the holes being baked (a single hole stays small).
  const margin = opts.margin ?? (holeWays.length === 1 ? 120 : 60);
  const xs = lines.flat().map((p) => p[0]);
  const zs = lines.flat().map((p) => p[1]);
  if (boundaryRing && !opts.holes) {
    xs.push(...boundaryRing.map((p) => p[0]));
    zs.push(...boundaryRing.map((p) => p[1]));
  }
  const minX = Math.floor(Math.min(...xs) - margin);
  const maxX = Math.ceil(Math.max(...xs) + margin);
  const minZ = Math.floor(Math.min(...zs) - margin);
  const maxZ = Math.ceil(Math.max(...zs) + margin);
  const inBox = ([x, z]: [number, number]) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  const anyInBox = (poly: [number, number][]) => poly.some(inBox);

  const areas: Area[] = [];
  const features: CourseFeatures = { trees: [], woods: [], treeRows: [] };
  for (const e of elements) {
    const lie = lieForTags(e.tags);
    const wood = woodKind(e.tags);
    if (lie || wood) {
      for (const ring of outerRings(e)) {
        const poly = ring.map(toXZ);
        if (!anyInBox(poly)) continue;
        if (lie) areas.push({ lie, polygon: poly });
        else features.woods!.push({ kind: wood!, polygon: poly });
      }
    }
    if (e.type === "node" && e.tags?.natural === "tree" && e.lat !== undefined && e.lon !== undefined) {
      const p = toXZ({ lat: e.lat, lon: e.lon });
      if (inBox(p)) features.trees!.push(p);
    }
    if (e.tags?.natural === "tree_row" && e.geometry) {
      const line = e.geometry.map(toXZ);
      if (anyInBox(line)) features.treeRows!.push(line);
    }
  }

  // Ground: DEM heights relative to the first tee, then course shaping.
  const cell = opts.cellSize ?? 4;
  const cols = Math.round((maxX - minX) / cell) + 1;
  const rows = Math.round((maxZ - minZ) / cell) + 1;
  const base = heightAt(origin);
  const heights = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r * cols + c] = heightAt(proj.toLatLon(minX + c * cell, minZ + r * cell)) - base;
    }
  }
  shapeGround(heights, cols, rows, minX, minZ, cell, areas);

  const hAt = (x: number, z: number) => {
    const c = Math.min(cols - 1, Math.max(0, Math.round((x - minX) / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.round((z - minZ) / cell)));
    return heights[r * cols + c];
  };
  const pins = elements.filter((e) => e.type === "node" && e.tags?.golf === "pin" && e.lat !== undefined);

  const holes: HoleData[] = holeWays.map((w, i) => {
    const centerline = lines[i];
    const end = centerline[centerline.length - 1];
    let pin = end;
    for (const p of pins) {
      const q = toXZ({ lat: p.lat!, lon: p.lon! });
      if (Math.hypot(q[0] - end[0], q[1] - end[1]) < 40) pin = q;
    }
    const tee = centerline[0];
    return {
      number: Number(w.tags!.ref),
      ...(w.tags!.name ? { name: w.tags!.name } : {}),
      par: Number(w.tags!.par ?? 4),
      lengthYards: Math.round(polyLength(centerline) * 1.09361),
      tee: v3(tee[0], hAt(...tee), tee[1]),
      pin: v3(pin[0], hAt(...pin), pin[1]),
      centerline,
      areas: [],
    };
  });

  const bounds: Polygon2 = boundaryRing && !opts.holes
    ? boundaryRing
    : [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];

  return {
    name: opts.courseName ?? boundaryEl?.tags?.name ?? "Unnamed course",
    attribution: ["Course layout © OpenStreetMap contributors (ODbL)", "Elevation: AWS Terrain Tiles (Mapzen Terrarium)"],
    origin: { lat: origin.lat, lon: origin.lon },
    heightfield: {
      originX: minX,
      originZ: minZ,
      cellSize: cell,
      cols,
      rows,
      heights: Array.from(heights, (h) => Math.round(h * 100) / 100),
    },
    bounds,
    areas,
    features,
    holes,
  };
}

/** Single-hole convenience wrapper (terrain origin at that hole's tee). */
export function bakeHoleFromOsm(
  elements: OsmElement[],
  heightAt: HeightSampler,
  opts: Omit<BakeOptions, "holes"> & { hole: number },
): CourseData {
  return bakeCourseFromOsm(elements, heightAt, { ...opts, holes: [opts.hole] });
}

function distToRing(x: number, z: number, poly: Polygon2): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/**
 * Putting surfaces must hold a ball: at a stimp-10 pace anything steeper than ~5% sends it
 * back down. Replace each green (plus a margin) with the best-fit plane of the DEM, tilted
 * at most `maxSlope`, and blend it into the surrounding ground.
 */
function flattenGreens(h: Float64Array, cols: number, rows: number, x0: number, z0: number, cell: number, areas: Area[], maxSlope = 0.025, margin = 6, blend = 12) {
  for (const area of areas) {
    if (area.lie !== "green") continue;
    const xs = area.polygon.map((p) => p[0]);
    const zs = area.polygon.map((p) => p[1]);
    const pad = margin + blend;
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - pad - x0) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((Math.max(...xs) + pad - x0) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(...zs) - pad - z0) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((Math.max(...zs) + pad - z0) / cell));
    const cells: { i: number; x: number; z: number; d: number }[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = x0 + c * cell;
        const z = z0 + r * cell;
        const d = pointInPolygon(x, z, area.polygon) ? 0 : distToRing(x, z, area.polygon);
        if (d <= pad) cells.push({ i: r * cols + c, x, z, d });
      }
    }
    const fit = cells.filter((q) => q.d <= margin);
    if (fit.length < 3) continue;
    // Least-squares plane h = a x + b z + k around the green centre.
    const mx = fit.reduce((s, q) => s + q.x, 0) / fit.length;
    const mz = fit.reduce((s, q) => s + q.z, 0) / fit.length;
    const mh = fit.reduce((s, q) => s + h[q.i], 0) / fit.length;
    let sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
    for (const q of fit) {
      const dx = q.x - mx, dz = q.z - mz, dh = h[q.i] - mh;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz; sxh += dx * dh; szh += dz * dh;
    }
    const det = sxx * szz - sxz * sxz || 1;
    let a = (sxh * szz - szh * sxz) / det;
    let b = (szh * sxx - sxh * sxz) / det;
    const g = Math.hypot(a, b);
    if (g > maxSlope) {
      a *= maxSlope / g;
      b *= maxSlope / g;
    }
    for (const q of cells) {
      const plane = mh + a * (q.x - mx) + b * (q.z - mz);
      const w = Math.max(0, Math.min(1, 1 - (q.d - margin) / blend));
      h[q.i] = w * plane + (1 - w) * h[q.i];
    }
  }
}

/** Course shaping on the DEM: dig bunkers, sink water below its banks, level tee boxes. */
function shapeGround(h: Float64Array, cols: number, rows: number, x0: number, z0: number, cell: number, areas: Area[]) {
  flattenGreens(h, cols, rows, x0, z0, cell, areas);
  for (const area of areas) {
    if (area.lie !== "bunker" && area.lie !== "water" && area.lie !== "tee") continue;
    const xs = area.polygon.map((p) => p[0]);
    const zs = area.polygon.map((p) => p[1]);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / cell) - 1);
    const c1 = Math.min(cols - 1, Math.ceil((Math.max(...xs) - x0) / cell) + 1);
    const r0 = Math.max(0, Math.floor((Math.min(...zs) - z0) / cell) - 1);
    const r1 = Math.min(rows - 1, Math.ceil((Math.max(...zs) - z0) / cell) + 1);
    const inside: number[] = [];
    let sum = 0;
    let rim = Infinity;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        if (pointInPolygon(x0 + c * cell, z0 + r * cell, area.polygon)) {
          inside.push(i);
          sum += h[i];
        } else {
          rim = Math.min(rim, h[i]);
        }
      }
    }
    if (inside.length === 0) continue;
    const mean = sum / inside.length;
    for (const i of inside) {
      if (area.lie === "bunker") h[i] -= 0.4;
      else if (area.lie === "water") h[i] = Math.min(h[i], (Number.isFinite(rim) ? rim : mean) - 0.9);
      else h[i] = mean + 0.3; // tee box: level, slightly raised
    }
  }
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
