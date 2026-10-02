import { describe, expect, it } from "vitest";
import { bakeHoleFromOsm, lieForTags, lonLatToTile, terrariumHeight, type OsmElement } from "../src/course/osm";
import { TerrainModel } from "../src/course/terrain";

const ring = (lat: number, lon: number, dLat: number, dLon: number) => [
  { lat: lat - dLat, lon: lon - dLon },
  { lat: lat - dLat, lon: lon + dLon },
  { lat: lat + dLat, lon: lon + dLon },
  { lat: lat + dLat, lon: lon - dLon },
];

// A due-north 400 m hole near Northallerton with a fairway, green and pond.
const lat0 = 54.34;
const lon0 = -1.45;
const north = (m: number) => lat0 + m / 111_320;
const elements: OsmElement[] = [
  { type: "way", id: 1, tags: { golf: "hole", ref: "2", par: "4" }, geometry: [{ lat: lat0, lon: lon0 }, { lat: north(366), lon: lon0 }] },
  { type: "way", id: 2, tags: { golf: "fairway" }, geometry: ring(north(200), lon0, 120 / 111_320, 0.0003) },
  { type: "way", id: 3, tags: { golf: "green" }, geometry: ring(north(366), lon0, 12 / 111_320, 0.0002) },
  { type: "way", id: 4, tags: { natural: "water" }, geometry: ring(north(250), lon0 + 0.0008, 15 / 111_320, 0.0002) },
];

describe("OSM course baking", () => {
  it("maps golf tags to lies", () => {
    expect(lieForTags({ golf: "lateral_water_hazard" })).toBe("water");
    expect(lieForTags({ golf: "green" })).toBe("green");
    expect(lieForTags({ highway: "path" })).toBeNull();
  });

  it("bakes a hole with metric geometry, lies and relative heights", () => {
    const course = bakeHoleFromOsm(elements, (p) => 30 + (p.lat - lat0) * 111_320 * 0.01, { hole: 2 });
    const hole = course.holes[0];
    expect(hole.par).toBe(4);
    expect(hole.lengthYards).toBeGreaterThan(395);
    expect(hole.lengthYards).toBeLessThan(405);
    expect(hole.pin.z).toBeCloseTo(-366, 0); // north is -Z
    expect(hole.pin.y).toBeGreaterThan(3); // 1% uphill
    const t = new TerrainModel(course);
    expect(t.lieAt(0, -200)).toBe("fairway");
    expect(t.lieAt(0, -366)).toBe("green");
    expect(t.lieAt(52, -250)).toBe("water");
  });

  it("decodes Terrarium pixels and tile coordinates", () => {
    expect(terrariumHeight(128, 30, 128)).toBeCloseTo(30.5);
    const t = lonLatToTile({ lat: 0, lon: 0 }, 1);
    expect(t.x).toBeCloseTo(1);
    expect(t.y).toBeCloseTo(1);
  });
});

describe("whole-course baking", () => {
  const flat = () => 10;

  it("bakes every hole with pins, pars and shared areas", async () => {
    const { sampleCourseOsm } = await import("./sampleOsm");
    const { bakeCourseFromOsm } = await import("../src/course/osm");
    const course = bakeCourseFromOsm(sampleCourseOsm().elements, flat);
    expect(course.name).toBe("Sample Course (synthetic)");
    expect(course.holes.map((h) => [h.number, h.par])).toEqual([[1, 4], [2, 3], [3, 5]]);
    expect(course.holes[0].pin.x).toBeCloseTo(60, 0); // golf=pin node wins over the line end
    expect(course.holes[0].pin.z).toBeCloseTo(-355, 0);
    expect(course.areas!.filter((a) => a.lie === "bunker")).toHaveLength(10);
    expect(course.features!.trees).toHaveLength(7);
    expect(course.features!.woods!.map((w) => w.kind).sort()).toEqual(["scrub", "wood"]);
    expect(course.features!.treeRows).toHaveLength(1);

    // Lies resolve against course-wide areas from any hole.
    const t2 = new TerrainModel(course, 1);
    expect(t2.lieAt(178, -334)).toBe("water");
    expect(t2.lieAt(252, -330)).toBe("green");
    expect(t2.lieAt(500, 0)).toBe("out-of-bounds");
  });

  it("shapes the ground: bunkers below, water below its banks, tees level", async () => {
    const { sampleCourseOsm } = await import("./sampleOsm");
    const { bakeCourseFromOsm } = await import("../src/course/osm");
    const course = bakeCourseFromOsm(sampleCourseOsm().elements, flat);
    const t = new TerrainModel(course, 0);
    // Heights are relative to the first tee, which is levelled and raised 0.3 m.
    const fairway = t.heightAt(0, -150);
    expect(t.heightAt(24, -238)).toBeLessThan(fairway - 0.2);
    expect(t.heightAt(178, -334)).toBeLessThan(fairway - 0.7);
    expect(t.heightAt(0, -4)).toBeGreaterThan(fairway + 0.2);
  });

  it("greens hold a ball even on steep ground", async () => {
    const { sampleCourseOsm } = await import("./sampleOsm");
    const { bakeCourseFromOsm } = await import("../src/course/osm");
    // Ground tilted 10% towards +x everywhere.
    const steep = (p: { lat: number; lon: number }) => (p.lon + 1.452) * 111_320 * Math.cos((54.34 * Math.PI) / 180) * 0.1;
    const course = bakeCourseFromOsm(sampleCourseOsm().elements, steep);
    const t = new TerrainModel(course, 0);
    for (const [x, z] of [[62, -352], [55, -345], [70, -360]]) {
      const n = t.normalAt(x, z);
      expect(Math.hypot(n.x, n.z) / n.y).toBeLessThan(0.03);
    }
    const n = t.normalAt(0, -150); // fairway keeps the real slope
    expect(Math.hypot(n.x, n.z) / n.y).toBeGreaterThan(0.08);
  });

  it("joins multipolygon members into rings", async () => {
    const { assembleRings } = await import("../src/course/osm");
    const a = { lat: 0, lon: 0 }, b = { lat: 0, lon: 1 }, c = { lat: 1, lon: 1 }, d = { lat: 1, lon: 0 };
    const rings = assembleRings([[a, b], [c, b], [c, d, a]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
  });
});
