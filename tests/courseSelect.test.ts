import { describe, expect, it } from "vitest";
import { bakeCourseFromOsm, resolveHoleChain, type OsmElement } from "../src/course/osm";
import { makeProjection } from "../src/geo/projection";

const proj = makeProjection({ lat: 56.34, lon: -2.8 });
const ll = ([x, z]: [number, number]) => proj.toLatLon(x, z);
let id = 1;
const way = (tags: Record<string, string>, pts: [number, number][], closed = false): OsmElement => ({
  type: "way",
  id: id++,
  tags,
  geometry: (closed ? [...pts, pts[0]] : pts).map(ll),
});
const rect = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** A three-hole loop going north from (x0, 0), each hole 150 m, next tee 20 m from the green. */
function loop(x0: number, tag: string): OsmElement[] {
  const holes: OsmElement[] = [];
  let z = 0;
  for (let n = 1; n <= 3; n++) {
    holes.push(way({ golf: "hole", ref: String(n), par: "4", note: tag }, [[x0, z], [x0, z - 150]]));
    holes.push(way({ golf: "green" }, rect(x0 - 10, z - 160, x0 + 10, z - 140), true));
    z -= 170;
  }
  return holes;
}

describe("picking one course out of shared data", () => {
  it("bakes only the named course when courses have their own outlines", () => {
    const elements = [
      way({ leisure: "golf_course", name: "Old Course" }, rect(-60, 60, 60, -600), true),
      way({ leisure: "golf_course", name: "New Course" }, rect(140, 60, 260, -600), true),
      ...loop(0, "old"),
      ...loop(200, "new"),
    ];
    const course = bakeCourseFromOsm(elements, () => 0, { course: "old course" });
    expect(course.name).toBe("Old Course");
    expect(course.holes.map((h) => h.number)).toEqual([1, 2, 3]);
    expect(course.areas!.filter((a) => a.lie === "green")).toHaveLength(3);
    // All holes on the old course's line (x = 0 in that frame).
    const xs = course.holes.map((h) => h.tee.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
  });

  it("separates interleaved courses inside one outline by the walking chain", () => {
    const old = loop(0, "old").filter((e) => e.tags!.golf === "hole");
    const other = loop(400, "new").filter((e) => e.tags!.golf === "hole");
    // Shuffle them together.
    const mixed = [other[1], old[0], other[0], old[2], other[2], old[1]];
    const chain = resolveHoleChain(mixed);
    expect(chain.map((h) => h.tags!.ref)).toEqual(["1", "2", "3"]);
    const notes = new Set(chain.map((h) => h.tags!.note));
    expect(notes.size).toBe(1);
  });

  it("explains which courses exist when the name doesn't match", () => {
    const elements = [way({ leisure: "golf_course", name: "Jubilee Course" }, rect(-60, 60, 60, -600), true), ...loop(0, "j")];
    expect(() => bakeCourseFromOsm(elements, () => 0, { course: "Old" })).toThrow(/Jubilee Course/);
  });
});
