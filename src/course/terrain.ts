import { type Vec3, normalize, v3 } from "../math/vec3";
import type { Area, CourseData, Heightfield, Lie, Polygon2 } from "./types";

const LIE_PRIORITY: Lie[] = ["water", "bunker", "green", "tee", "fairway", "rough"];

export function pointInPolygon(x: number, z: number, poly: Polygon2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function boundingBox(poly: Polygon2): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

/** Physics-side view of a course: ground height, normals and lie lookup. */
export class TerrainModel {
  private readonly hf: Heightfield;
  private readonly areas: (Area & { box: [number, number, number, number] })[];

  constructor(
    private readonly course: CourseData,
    holeIndex = 0,
  ) {
    this.hf = course.heightfield;
    const hole = course.holes[holeIndex];
    this.areas = [...(course.areas ?? []), ...hole.areas]
      .sort((a, b) => LIE_PRIORITY.indexOf(a.lie) - LIE_PRIORITY.indexOf(b.lie))
      .map((a) => ({ ...a, box: boundingBox(a.polygon) }));
  }

  heightAt(x: number, z: number): number {
    const { originX, originZ, cellSize, cols, rows, heights } = this.hf;
    const gx = Math.min(Math.max((x - originX) / cellSize, 0), cols - 1.000001);
    const gz = Math.min(Math.max((z - originZ) / cellSize, 0), rows - 1.000001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h = (c: number, r: number) => heights[r * cols + c];
    const top = h(i, j) * (1 - fx) + h(i + 1, j) * fx;
    const bottom = h(i, j + 1) * (1 - fx) + h(i + 1, j + 1) * fx;
    return top * (1 - fz) + bottom * fz;
  }

  normalAt(x: number, z: number): Vec3 {
    const e = this.hf.cellSize * 0.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return normalize(v3(-dx, 2 * e, -dz));
  }

  lieAt(x: number, z: number): Lie {
    if (!pointInPolygon(x, z, this.course.bounds)) return "out-of-bounds";
    for (const { box, polygon, lie } of this.areas) {
      if (x < box[0] || x > box[2] || z < box[1] || z > box[3]) continue;
      if (pointInPolygon(x, z, polygon)) return lie;
    }
    return "rough";
  }

  /** Signed height of a point above the ground. */
  clearance(p: Vec3): number {
    return p.y - this.heightAt(p.x, p.z);
  }
}
