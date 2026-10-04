import { describe, expect, it } from "vitest";
import { bakeCourseFromOsm, resolveHoleChain, type OsmElement } from "../src/course/osm";
import { makeProjection } from "../src/geo/projection";
import { TerrainModel } from "../src/course/terrain";

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

  it("prefers the main course over a par-3 course in the same grounds", () => {
    // Main course: 400 m holes going out and back; par-3 course: 120 m holes packed near
    // the clubhouse. Both have short walks from each green to the next tee.
    const main: OsmElement[] = [];
    const par3: OsmElement[] = [];
    for (let n = 1; n <= 4; n++) {
      const up = n % 2 === 1;
      main.push(way({ golf: "hole", ref: String(n), note: "main" }, up ? [[n * 30, 0], [n * 30, -400]] : [[n * 30, -400], [n * 30, 0]]));
      par3.push(way({ golf: "hole", ref: String(n), note: "par3" }, up ? [[-100 - n * 15, 0], [-100 - n * 15, -120]] : [[-100 - n * 15, -120], [-100 - n * 15, 0]]));
    }
    const chain = resolveHoleChain([...par3, ...main]);
    expect(chain.map((h) => h.tags!.note)).toEqual(["main", "main", "main", "main"]);
  });

  it("keeps a shared links fairway crossed by the course's holes, with its cut-outs", () => {
    // One fairway multipolygon spanning both courses (centre outside the Old outline),
    // with a gorse island cut out of it.
    const ringPts = (pts: [number, number][]) => [...pts, pts[0]].map(ll);
    const fairway: OsmElement = {
      type: "relation",
      id: id++,
      tags: { golf: "fairway", type: "multipolygon" },
      members: [
        { type: "way", role: "outer", geometry: ringPts(rect(-40, -20, 400, -500)) },
        { type: "way", role: "inner", geometry: ringPts(rect(-10, -200, 10, -220)) },
      ],
    };
    const elements = [
      way({ leisure: "golf_course", name: "Old Course" }, rect(-60, 60, 60, -600), true),
      ...loop(0, "old"),
      fairway,
    ];
    const course = bakeCourseFromOsm(elements, () => 0, { course: "Old Course" });
    const fw = course.areas!.filter((a) => a.lie === "fairway");
    expect(fw).toHaveLength(1);
    expect(fw[0].holes).toHaveLength(1);
    const t = new TerrainModel(course, 0);
    expect(t.lieAt(0, -100)).toBe("fairway");
    expect(t.lieAt(0, -210)).toBe("rough"); // inside the cut-out
  });

  it("explains which courses exist when the name doesn't match", () => {
    const elements = [way({ leisure: "golf_course", name: "Jubilee Course" }, rect(-60, 60, 60, -600), true), ...loop(0, "j")];
    expect(() => bakeCourseFromOsm(elements, () => 0, { course: "Old" })).toThrow(/Jubilee Course/);
  });
});
