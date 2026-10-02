import { describe, expect, it } from "vitest";
import { bakeCourseFromOsm } from "../src/course/osm";
import { Round } from "../src/game/round";
import { v3 } from "../src/math/vec3";
import { sampleCourseOsm } from "./sampleOsm";

const course = bakeCourseFromOsm(sampleCourseOsm().elements, () => 0);

function holeOut(round: Round) {
  const s = round.session;
  for (let i = 0; i < 15 && s.phase !== "holed"; i++) {
    const d = s.distanceToPin;
    const power = s.club.isPutter ? Math.min(1, (d * 1.05 + 0.2) / s.puttRange) : Math.min(1, d / (s.carries.get(s.club.id)! + 5));
    s.hit({ power, tempo: 1, pathDeg: 0 });
    s.finishShot();
  }
  round.record();
}

describe("Round", () => {
  it("plays holes in order, keeps a scorecard and totals against par", () => {
    const round = new Round(course, v3());
    expect(round.session.hole.number).toBe(1);
    holeOut(round);
    expect(round.scores[0]).toBeGreaterThan(0);
    expect(round.nextIndex()).toBe(1);
    round.play(1);
    expect(round.session.hole.par).toBe(3);
    holeOut(round);
    const t = round.totals();
    expect(t.played).toBe(2);
    expect(t.par).toBe(7);
    expect(t.toPar).toBe(t.strokes - 7);
  });

  it("restarting a hole clears its score and the round ends when all are scored", () => {
    const round = new Round(course, v3(), 2);
    holeOut(round);
    expect(round.scores[2]).not.toBeNull();
    round.play(2);
    expect(round.scores[2]).toBeNull();
    round.scores[0] = 4;
    round.scores[1] = 3;
    round.scores[2] = 5;
    expect(round.nextIndex()).toBeNull();
  });
});
