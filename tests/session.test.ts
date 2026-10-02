import { describe, expect, it } from "vitest";
import { HoleSession } from "../src/game/session";
import { testCourse } from "./fixtures";

const straight = { power: 1, tempo: 1, pathDeg: 0 };

describe("HoleSession", () => {
  it("picks a driver off the tee and a putter on the green", () => {
    const s = new HoleSession(testCourse());
    expect(s.club.id).toBe("1W");
    s.lie = "green";
    expect(s.suggestClub().id).toBe("PT");
  });

  it("plays a shot, counts the stroke and re-aims at the pin", () => {
    const s = new HoleSession(testCourse());
    s.hit(straight);
    expect(s.phase).toBe("flight");
    s.finishShot();
    expect(s.phase).toBe("address");
    expect(s.strokes).toBe(1);
    expect(s.lastResult!.carry).toBeGreaterThan(200);
    expect(s.distanceToPin).toBeLessThan(150);
  });

  it("water costs a stroke and drops the ball outside the hazard", () => {
    const s = new HoleSession(testCourse());
    s.selectClub(2); // 5 wood towards the pond on the right
    s.aimHeading = Math.atan2(60, 200);
    s.hit(straight);
    s.finishShot();
    expect(s.lastResult!.penalty).toBe("water");
    expect(s.strokes).toBe(2);
    expect(s.terrain.lieAt(s.ballPos.x, s.ballPos.z)).not.toBe("water");
  });

  it("out of bounds is stroke and distance", () => {
    const s = new HoleSession(testCourse());
    s.aimHeading = -Math.PI / 2.5; // way left
    s.hit(straight);
    s.finishShot();
    expect(s.lastResult!.penalty).toBe("out-of-bounds");
    expect(s.strokes).toBe(2);
    expect(s.ballPos.z).toBeCloseTo(0, 1);
  });

  it("can hole out", () => {
    const s = new HoleSession(testCourse());
    for (let i = 0; i < 12 && s.phase !== "holed"; i++) {
      // A simple bot: full shots until close, then perfectly paced putts.
      const d = s.distanceToPin;
      const power = s.club.isPutter ? Math.min(1, d / s.puttRange + 0.02) : Math.min(1, d / (s.carries.get(s.club.id)! + 5));
      s.hit({ power, tempo: 1, pathDeg: 0 });
      s.finishShot();
    }
    expect(s.phase).toBe("holed");
    expect(s.strokes).toBeLessThanOrEqual(6);
  });
});
