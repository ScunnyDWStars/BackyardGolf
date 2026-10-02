import { type Vec3, normalize, v3 } from "../math/vec3";
import type { CourseData, Heightfield, Lie, Polygon2 } from "./types";

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

/** Physics-side view of a course: ground height, normals and lie lookup. */
export class TerrainModel {
  private readonly hf: Heightfield;
  private readonly areas: { lie: Lie; polygon: Polygon2 }[];

  constructor(
    private readonly course: CourseData,
    holeIndex = 0,
  ) {
    this.hf = course.heightfield;
    const hole = course.holes[holeIndex];
    this.areas = [...hole.areas].sort(
      (a, b) => LIE_PRIORITY.indexOf(a.lie) - LIE_PRIORITY.indexOf(b.lie),
    );
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
    for (const area of this.areas) if (pointInPolygon(x, z, area.polygon)) return area.lie;
    return "rough";
  }

  /** Signed height of a point above the ground. */
  clearance(p: Vec3): number {
    return p.y - this.heightAt(p.x, p.z);
  }
}
