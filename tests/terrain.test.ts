import { describe, expect, it } from "vitest";
import { TerrainModel, pointInPolygon } from "../src/course/terrain";
import { makeProjection } from "../src/geo/projection";
import { testCourse } from "./fixtures";

describe("TerrainModel", () => {
  it("interpolates heights and slope normals", () => {
    const t = new TerrainModel(testCourse({ slope: 0.05 }));
    expect(t.heightAt(0, -100)).toBeCloseTo(0);
    expect(t.heightAt(15, -100)).toBeCloseTo(0.75);
    const n = t.normalAt(0, -100);
    expect(n.y).toBeGreaterThan(0.99);
    expect(n.x).toBeLessThan(0); // ground rises to +x, so the normal leans to -x
  });

  it("resolves lies with hazards taking priority", () => {
    const t = new TerrainModel(testCourse());
    expect(t.lieAt(0, 0)).toBe("tee");
    expect(t.lieAt(0, -200)).toBe("fairway");
    expect(t.lieAt(60, -200)).toBe("water");
    expect(t.lieAt(0, -380)).toBe("green");
    expect(t.lieAt(-27, -370)).toBe("bunker");
    expect(t.lieAt(-100, -200)).toBe("rough");
    expect(t.lieAt(-170, -200)).toBe("out-of-bounds");
  });

  it("point in polygon handles concave shapes", () => {
    const L: [number, number][] = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];
    expect(pointInPolygon(1, 5, L)).toBe(true);
    expect(pointInPolygon(5, 5, L)).toBe(false);
  });
});

describe("projection", () => {
  it("round-trips and has metric scale", () => {
    const p = makeProjection({ lat: 54.34, lon: -1.45 });
    const a = p.toLocal({ lat: 54.341, lon: -1.45 });
    expect(a.z).toBeCloseTo(-111.3, 0); // 0.001 deg latitude ~ 111 m north (-Z)
    const back = p.toLatLon(a.x, a.z);
    expect(back.lat).toBeCloseTo(54.341, 9);
  });
});
