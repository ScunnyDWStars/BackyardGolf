import { TerrainModel } from "./terrain";
import type { CourseData } from "./types";

/**
 * Place a hole captured as a splat (with its own "hole frame" course file) into a full
 * course baked from map data.
 *
 * The hole frame's scale came from a scorecard estimate; the map knows the true tee and
 * green positions. A 2D similarity (rotation about the vertical, uniform scale, shift)
 * maps the captured tee and pin onto the map's, which also corrects the scale. The splat
 * transform is re-based through it, and the captured ground is blended into the course
 * terrain along the hole so the ball still sits on the turf the player sees.
 */
export interface Similarity {
  scale: number;
  angle: number; // radians, rotation in the x/z plane
  tx: number;
  ty: number;
  tz: number;
}

export function fitSimilarity(
  from: { tee: [number, number]; pin: [number, number]; teeY: number },
  to: { tee: [number, number]; pin: [number, number]; teeY: number },
): Similarity {
  const v = [from.pin[0] - from.tee[0], from.pin[1] - from.tee[1]];
  const V = [to.pin[0] - to.tee[0], to.pin[1] - to.tee[1]];
  const scale = Math.hypot(V[0], V[1]) / Math.hypot(v[0], v[1]);
  const angle = Math.atan2(V[1], V[0]) - Math.atan2(v[1], v[0]);
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return {
    scale,
    angle,
    tx: to.tee[0] - (c * from.tee[0] - s * from.tee[1]),
    tz: to.tee[1] - (s * from.tee[0] + c * from.tee[1]),
    ty: to.teeY - scale * from.teeY,
  };
}

export function applySimilarity(t: Similarity, x: number, y: number, z: number): [number, number, number] {
  const c = Math.cos(t.angle) * t.scale;
  const s = Math.sin(t.angle) * t.scale;
  return [c * x - s * z + t.tx, t.scale * y + t.ty, s * x + c * z + t.tz];
}

export function invertSimilarityXZ(t: Similarity, x: number, z: number): [number, number] {
  const dx = (x - t.tx) / t.scale;
  const dz = (z - t.tz) / t.scale;
  const c = Math.cos(-t.angle);
  const s = Math.sin(-t.angle);
  return [c * dx - s * dz, s * dx + c * dz];
}

/** Row-major 4x4 for the similarity (matches SplatInfo.matrix). */
export function similarityMatrix(t: Similarity): number[][] {
  const c = Math.cos(t.angle) * t.scale;
  const s = Math.sin(t.angle) * t.scale;
  return [
    [c, 0, -s, t.tx],
    [0, t.scale, 0, t.ty],
    [s, 0, c, t.tz],
    [0, 0, 0, 1],
  ];
}

export function multiply(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)));
}

function distToPolyline(x: number, z: number, cl: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < cl.length; i++) {
    const [ax, az] = cl[i];
    const [bx, bz] = cl[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

export interface AttachResult {
  course: CourseData;
  transform: Similarity;
}

/** Attach `captured` (a one-hole course file with a splat) to hole `holeNumber` of `course`. */
export function attachSplatHole(
  course: CourseData,
  captured: CourseData,
  holeNumber: number,
  opts: { splatUrl?: string; blendInner?: number; blendOuter?: number } = {},
): AttachResult {
  const holeIndex = course.holes.findIndex((h) => h.number === holeNumber);
  if (holeIndex < 0) throw new Error(`course has no hole ${holeNumber}`);
  if (!captured.splat) throw new Error("captured hole has no splat");
  const target = course.holes[holeIndex];
  const source = captured.holes[0];
  const transform = fitSimilarity(
    { tee: [source.tee.x, source.tee.z], pin: [source.pin.x, source.pin.z], teeY: source.tee.y },
    { tee: [target.tee.x, target.tee.z], pin: [target.pin.x, target.pin.z], teeY: target.tee.y },
  );

  // Blend the captured ground into the course terrain along the hole.
  const inner = opts.blendInner ?? 45;
  const outer = opts.blendOuter ?? 70;
  const capTerrain = new TerrainModel(captured);
  const chf = captured.heightfield;
  const inCaptured = (x: number, z: number) =>
    x >= chf.originX && z >= chf.originZ && x <= chf.originX + (chf.cols - 1) * chf.cellSize && z <= chf.originZ + (chf.rows - 1) * chf.cellSize;
  const hf = course.heightfield;
  const heights = [...hf.heights];
  for (let r = 0; r < hf.rows; r++) {
    for (let c = 0; c < hf.cols; c++) {
      const x = hf.originX + c * hf.cellSize;
      const z = hf.originZ + r * hf.cellSize;
      const d = distToPolyline(x, z, target.centerline);
      if (d >= outer) continue;
      const [hx, hz] = invertSimilarityXZ(transform, x, z);
      if (!inCaptured(hx, hz)) continue;
      const w = d <= inner ? 1 : 1 - (d - inner) / (outer - inner);
      const captured_y = transform.scale * capTerrain.heightAt(hx, hz) + transform.ty;
      const i = r * hf.cols + c;
      heights[i] = Math.round((w * captured_y + (1 - w) * heights[i]) * 100) / 100;
    }
  }

  const matrix = multiply(similarityMatrix(transform), captured.splat.matrix);
  return {
    transform,
    course: {
      ...course,
      attribution: [...course.attribution, ...captured.attribution],
      heightfield: { ...hf, heights },
      splat: { matrix, holes: [holeNumber], ...(opts.splatUrl ? { url: opts.splatUrl } : {}) },
    },
  };
}
