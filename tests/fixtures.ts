import type { CourseData, Lie, Polygon2 } from "../src/course/types";
import { v3 } from "../src/math/vec3";

const rect = (x0: number, z0: number, x1: number, z1: number): Polygon2 => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

/** A flat 400 m test hole: fairway down the middle, green at z=-380, pond at z=-200 right. */
export function testCourse(opts: { slope?: number; areas?: { lie: Lie; polygon: Polygon2 }[] } = {}): CourseData {
  const cols = 41;
  const rows = 61;
  const cell = 10;
  const originX = -200;
  const originZ = -500;
  const heights: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) heights.push((originX + c * cell) * (opts.slope ?? 0));
  return {
    name: "Test Hole",
    attribution: [],
    heightfield: { originX, originZ, cellSize: cell, cols, rows, heights },
    bounds: rect(-150, -480, 150, 50),
    holes: [
      {
        number: 1,
        par: 4,
        lengthYards: 415,
        tee: v3(0, 0, 0),
        pin: v3(0, 0, -380),
        centerline: [
          [0, 0],
          [0, -380],
        ],
        areas: opts.areas ?? [
          { lie: "tee", polygon: rect(-5, -5, 5, 5) },
          { lie: "fairway", polygon: rect(-20, -360, 20, -60) },
          { lie: "green", polygon: rect(-15, -395, 15, -365) },
          { lie: "water", polygon: rect(30, -230, 90, -170) },
          { lie: "bunker", polygon: rect(-35, -380, -20, -365) },
        ],
      },
    ],
  };
}
