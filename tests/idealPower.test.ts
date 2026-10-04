import { describe, expect, it } from "vitest";
import { HoleSession } from "../src/game/session";
import { clubById } from "../src/game/clubs";
import { headingOf, v3 } from "../src/math/vec3";
import { testCourse } from "./fixtures";

const everywhere = (lie: "green" | "fairway") => [{ lie, polygon: [[-200, -500], [200, -500], [200, 100], [-200, 100]] as [number, number][] }];

function sessionAt(opts: { slope?: number; lie: "green" | "fairway"; from: [number, number]; pin: [number, number] }) {
  const course = testCourse({ slope: opts.slope ?? 0, areas: everywhere(opts.lie) });
  course.holes[0].pin = v3(opts.pin[0], 0, opts.pin[1]);
  const s = new HoleSession(course);
  s.ballPos = s.groundAt(v3(opts.from[0], 0, opts.from[1]));
  s.lie = opts.lie;
  s.hole.pin.y = s.groundAt(s.hole.pin).y;
  s.aimHeading = headingOf(s.ballPos, s.hole.pin);
  s.club = s.suggestClub();
  return s;
}

describe("ideal power (the meter's target mark)", () => {
  it("a putt at ideal power drops on a flat green", () => {
    const s = sessionAt({ lie: "green", from: [0, -100], pin: [0, -106] });
    expect(s.club.id).toBe("PT");
    s.hit({ power: s.idealPower(), tempo: 1, pathDeg: 0 });
    s.finishShot();
    expect(s.phase).toBe("holed");
  });

  it("uphill putts need more power than downhill ones", () => {
    // Ground rises towards +x by 2%.
    const up = sessionAt({ slope: 0.02, lie: "green", from: [-6, -100], pin: [0, -100] });
    const down = sessionAt({ slope: 0.02, lie: "green", from: [6, -100], pin: [0, -100] });
    expect(up.idealPower()).toBeGreaterThan(down.idealPower() * 1.15);
    up.hit({ power: up.idealPower(), tempo: 1, pathDeg: 0 });
    up.finishShot();
    expect(up.phase).toBe("holed");
  });

  it("a 40-yard pitch at ideal power finishes within 2 m of the pin", () => {
    const s = sessionAt({ lie: "fairway", from: [0, -100], pin: [0, -136.6] });
    expect(["LW", "SW"]).toContain(s.club.id);
    s.hit({ power: s.idealPower(), tempo: 1, pathDeg: 0 });
    s.finishShot();
    expect(s.distanceToPin).toBeLessThan(2);
  });

  it("the gap wedge fills the PW–SW gap", () => {
    const s = sessionAt({ lie: "fairway", from: [0, 0], pin: [0, -300] });
    const pw = s.carries.get("PW")!;
    const gw = s.carries.get("GW")!;
    const sw = s.carries.get("SW")!;
    expect(gw).toBeLessThan(pw - 8);
    expect(gw).toBeGreaterThan(sw + 8);
    expect(clubById("GW").name).toBe("Gap Wedge");
  });
});
