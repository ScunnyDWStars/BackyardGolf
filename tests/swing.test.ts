import { describe, expect, it } from "vitest";
import { AnalogSwing, type SwingSample } from "../src/swing/analogSwing";

const config = { fullSwingPx: 200, idealDownswingTime: 0.25 };

function stroke(depth: number, downTime: number, drift = 0): SwingSample[] {
  const s: SwingSample[] = [];
  for (let i = 0; i <= 10; i++) s.push({ t: i * 0.05, x: 0, y: (depth * i) / 10 });
  const t0 = 0.5;
  for (let i = 1; i <= 10; i++)
    s.push({ t: t0 + (downTime * i) / 10, x: (drift * i) / 10, y: depth - ((depth + 10) * i) / 10 });
  return s;
}

function run(samples: SwingSample[]) {
  const swing = new AnalogSwing(config);
  swing.begin(samples[0]);
  for (const s of samples.slice(1)) swing.move(s);
  return swing;
}

describe("AnalogSwing", () => {
  it("full, straight, fast stroke gives full power and no curve", () => {
    const swing = run(stroke(200, 0.15));
    expect(swing.phase).toBe("done");
    expect(swing.result!.power).toBeCloseTo(1, 2);
    expect(swing.result!.tempo).toBe(1);
    expect(Math.abs(swing.result!.pathDeg)).toBeLessThan(0.01);
  });

  it("backswing depth sets power and overswing is capped", () => {
    expect(run(stroke(100, 0.1)).result!.power).toBeCloseTo(0.5, 2);
    expect(run(stroke(400, 0.2)).result!.power).toBeCloseTo(1.1, 2);
  });

  it("slow downswing loses tempo; a short but brisk stroke keeps it", () => {
    expect(run(stroke(200, 1.0)).result!.tempo).toBeLessThan(0.3);
    expect(run(stroke(30, 0.2)).result!.tempo).toBe(1);
  });

  it("drifting right gives a positive path angle", () => {
    expect(run(stroke(200, 0.15, 30)).result!.pathDeg).toBeGreaterThan(5);
    expect(run(stroke(200, 0.15, -30)).result!.pathDeg).toBeLessThan(-5);
  });

  it("releasing during the backswing cancels", () => {
    const swing = new AnalogSwing(config);
    swing.begin({ t: 0, x: 0, y: 0 });
    swing.move({ t: 0.1, x: 0, y: 50 });
    swing.end({ t: 0.2, x: 0, y: 60 });
    expect(swing.phase).toBe("idle");
    expect(swing.result).toBeNull();
  });
});
