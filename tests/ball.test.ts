import { describe, expect, it } from "vitest";
import { TerrainModel } from "../src/course/terrain";
import { clubById } from "../src/game/clubs";
import { launchBall, simulate } from "../src/physics/ball";
import { v3 } from "../src/math/vec3";
import { shotFromSwing } from "../src/swing/analogSwing";
import { testCourse } from "./fixtures";

const fairwayEverywhere = testCourse({
  areas: [{ lie: "fairway", polygon: [[-200, -500], [200, -500], [200, 100], [-200, 100]] }],
});
const env = (wind = v3()) => ({
  terrain: new TerrainModel({ ...fairwayEverywhere, bounds: [[-200, -500], [200, -500], [200, 100], [-200, 100]] }),
  wind,
  pin: v3(0, 0, -2000),
});

function fullShot(clubId: string, opts: { pathDeg?: number; wind?: ReturnType<typeof v3> } = {}) {
  const launch = shotFromSwing(clubById(clubId), { power: 1, tempo: 1, pathDeg: opts.pathDeg ?? 0 }, 0);
  return simulate(launchBall(v3(0, 0.02, 0), launch, "tee"), env(opts.wind));
}

describe("ball flight", () => {
  // Tour averages (TrackMan): driver ~251 m carry, 7-iron ~157 m, PW ~124 m.
  it.each([
    ["1W", 230, 270],
    ["7I", 145, 170],
    ["PW", 105, 130],
  ])("%s carries within the tour band", (club, lo, hi) => {
    const { final } = fullShot(club);
    const carry = -final.firstLanding!.z;
    expect(carry).toBeGreaterThan(lo);
    expect(carry).toBeLessThan(hi);
    expect(Math.abs(final.pos.x)).toBeLessThan(0.5); // straight shot stays straight
  });

  it("a straight swing has no sidespin; drifting right slices right, left draws left", () => {
    expect(shotFromSwing(clubById("7I"), { power: 1, tempo: 1, pathDeg: 0 }, 0).sidespinRpm).toBe(0);
    expect(fullShot("7I", { pathDeg: 8 }).final.pos.x).toBeGreaterThan(10);
    expect(fullShot("7I", { pathDeg: -8 }).final.pos.x).toBeLessThan(-10);
  });

  it("headwind shortens and tailwind lengthens a drive", () => {
    const calm = -fullShot("1W").final.firstLanding!.z;
    const head = -fullShot("1W", { wind: v3(0, 0, 8) }).final.firstLanding!.z;
    const tail = -fullShot("1W", { wind: v3(0, 0, -8) }).final.firstLanding!.z;
    expect(head).toBeLessThan(calm - 10);
    expect(tail).toBeGreaterThan(calm + 5);
  });

  it("half power carries about half as far", () => {
    const full = -fullShot("7I").final.firstLanding!.z;
    const launch = shotFromSwing(clubById("7I"), { power: 0.5, tempo: 1, pathDeg: 0 }, 0);
    const half = -simulate(launchBall(v3(0, 0.02, 0), launch, "tee"), env()).final.firstLanding!.z;
    expect(half / full).toBeGreaterThan(0.42);
    expect(half / full).toBeLessThan(0.58);
  });

  it("a soft wedge chip runs forward instead of spinning back", () => {
    const launch = shotFromSwing(clubById("LW"), { power: 0.25, tempo: 1, pathDeg: 0 }, 0);
    const { final } = simulate(launchBall(v3(0, 0.02, 0), launch, "tee"), env());
    const carry = -final.firstLanding!.z;
    expect(carry).toBeGreaterThan(5);
    expect(-final.pos.z).toBeGreaterThan(carry * 0.9);
  });

  it("wedges stop quickly; drivers run out", () => {
    const pw = fullShot("PW").final;
    const dr = fullShot("1W").final;
    const pwRoll = -pw.pos.z - -pw.firstLanding!.z;
    const drRoll = -dr.pos.z - -dr.firstLanding!.z;
    expect(pwRoll).toBeLessThan(20);
    expect(drRoll).toBeGreaterThan(pwRoll);
  });
});

describe("putting", () => {
  const green = testCourse({
    areas: [{ lie: "green", polygon: [[-200, -500], [200, -500], [200, 100], [-200, 100]] }],
  });
  const terrain = new TerrainModel({ ...green, bounds: [[-200, -500], [200, -500], [200, 100], [-200, 100]] });

  it("power maps to roll distance on a flat green", () => {
    const launch = shotFromSwing(clubById("PT"), { power: 0.5, tempo: 1, pathDeg: 0 }, 0, {
      puttDistance: 20,
      greenDecel: 0.55,
    });
    const { final } = simulate(launchBall(v3(), launch, "green"), { terrain, wind: v3(), pin: v3(0, 0, -2000) });
    expect(-final.pos.z).toBeGreaterThan(9);
    expect(-final.pos.z).toBeLessThan(11);
  });

  it("a well-paced putt drops", () => {
    const launch = shotFromSwing(clubById("PT"), { power: 0.8, tempo: 1, pathDeg: 0 }, 0, {
      puttDistance: 10,
      greenDecel: 0.55,
    });
    const { final } = simulate(launchBall(v3(), launch, "green"), { terrain, wind: v3(), pin: v3(0, 0, -6) });
    expect(final.phase).toBe("holed");
  });

  it("putts break downhill on a side slope", () => {
    const sloped = testCourse({
      slope: 0.02,
      areas: [{ lie: "green", polygon: [[-200, -500], [200, -500], [200, 100], [-200, 100]] }],
    });
    const t = new TerrainModel({ ...sloped, bounds: [[-200, -500], [200, -500], [200, 100], [-200, 100]] });
    const launch = shotFromSwing(clubById("PT"), { power: 1, tempo: 1, pathDeg: 0 }, 0, { puttDistance: 10 });
    const { final } = simulate(launchBall(v3(0, 0, 0), launch, "green"), { terrain: t, wind: v3(), pin: v3(0, 0, -2000) });
    expect(final.pos.x).toBeLessThan(-0.3); // ground rises to +x, ball falls to -x
  });
});
