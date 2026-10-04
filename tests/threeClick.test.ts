import { describe, expect, it } from "vitest";
import { OVERRUN, PITCH_METER, ThreeClickMeter } from "../src/swing/threeClick";

const cfg = { ...PITCH_METER, riseTime: 1, returnTime: 0.5 };
const run = (m: ThreeClickMeter, seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += 0.01) m.update(0.01);
};

describe("ThreeClickMeter", () => {
  it("rises, locks power on the second click and is straight inside the zone", () => {
    const m = new ThreeClickMeter(cfg);
    m.click();
    run(m, 0.6);
    m.click();
    expect(m.power).toBeCloseTo(0.6, 2);
    while (m.marker > 0.005) m.update(0.005);
    m.click();
    expect(m.phase).toBe("done");
    expect(m.result).toEqual({ power: m.power, tempo: 1, pathDeg: 0 });
  });

  it("early third click pulls left, late pushes right, missing it fires at worst", () => {
    const early = new ThreeClickMeter(cfg);
    early.click(); run(early, 0.5); early.click(); run(early, 0.1); early.click();
    expect(early.result!.pathDeg).toBeLessThan(0);

    const late = new ThreeClickMeter(cfg);
    late.click(); run(late, 0.5); late.click();
    while (late.marker > -0.1) late.update(0.005);
    late.click();
    expect(late.result!.pathDeg).toBeGreaterThan(0);

    const missed = new ThreeClickMeter(cfg);
    missed.click(); run(missed, 0.5); missed.click(); run(missed, 3);
    expect(missed.phase).toBe("done");
    expect(missed.marker).toBe(-OVERRUN);
    expect(missed.result!.pathDeg).toBeCloseTo(cfg.maxPathDeg);
  });

  it("tops out at full power, then cancels if never locked", () => {
    const m = new ThreeClickMeter(cfg);
    m.click();
    run(m, 1.2);
    expect(m.phase).toBe("falling");
    run(m, 1.5);
    expect(m.phase).toBe("idle");
    expect(m.result).toBeNull();
  });
});
