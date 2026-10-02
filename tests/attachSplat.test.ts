import { describe, expect, it } from "vitest";
import { applySimilarity, attachSplatHole, fitSimilarity, multiply, similarityMatrix } from "../src/course/attachSplat";
import { TerrainModel } from "../src/course/terrain";
import type { CourseData } from "../src/course/types";
import { v3 } from "../src/math/vec3";

const flatField = (originX: number, originZ: number, cols: number, rows: number, h: (x: number, z: number) => number) => {
  const heights: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights.push(h(originX + c * 5, originZ + r * 5));
  return { originX, originZ, cellSize: 5, cols, rows, heights };
};

describe("attaching a captured hole", () => {
  it("fits rotation, scale and offset from tee and pin", () => {
    const t = fitSimilarity({ tee: [0, 0], pin: [0, -300], teeY: 0 }, { tee: [100, 50], pin: [430, 50], teeY: 12 });
    expect(t.scale).toBeCloseTo(1.1);
    const [x, y, z] = applySimilarity(t, 0, 0, -300);
    expect(x).toBeCloseTo(430);
    expect(z).toBeCloseTo(50);
    expect(y).toBeCloseTo(12);
    // The 4x4 form agrees with the function.
    const m = multiply(similarityMatrix(t), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, -300], [0, 0, 0, 1]]);
    expect(m[0][3]).toBeCloseTo(430);
    expect(m[2][3]).toBeCloseTo(50);
  });

  it("re-bases the splat and blends captured ground into the course along the hole", () => {
    // Captured hole: straight down -Z, ground rises 1 m per 100 m.
    const captured: CourseData = {
      name: "capture", attribution: ["capture"],
      heightfield: flatField(-60, -360, 25, 77, (_x, z) => -z / 100),
      bounds: [[-60, -360], [60, -360], [60, 20], [-60, 20]],
      holes: [{ number: 2, par: 4, lengthYards: 328, tee: v3(0, 0, 0), pin: v3(0, 3, -300), centerline: [[0, 0], [0, -300]], areas: [] }],
      splat: { matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
    };
    // Course: the same hole runs east, 10% longer, on flat ground at 20 m.
    const course: CourseData = {
      name: "course", attribution: ["osm"],
      heightfield: flatField(-50, -100, 100, 40, () => 20),
      bounds: [[-50, -100], [450, -100], [450, 100], [-50, 100]],
      holes: [{ number: 2, par: 4, lengthYards: 361, tee: v3(0, 20, 0), pin: v3(330, 20, 0), centerline: [[0, 0], [330, 0]], areas: [] }],
    };
    const { course: out, transform } = attachSplatHole(course, captured, 2, { splatUrl: "hole2.splat" });
    expect(transform.scale).toBeCloseTo(1.1);
    expect(out.splat!.holes).toEqual([2]);
    expect(out.splat!.url).toBe("hole2.splat");
    const t = new TerrainModel(out);
    expect(t.heightAt(0, 0)).toBeCloseTo(20, 1); // tees agree
    expect(t.heightAt(330, 0)).toBeCloseTo(20 + 1.1 * 3, 1); // captured slope, scaled
    expect(t.heightAt(165, 95)).toBeCloseTo(20, 1); // outside the blend corridor: map ground
  });
});
