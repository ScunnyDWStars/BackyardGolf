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
