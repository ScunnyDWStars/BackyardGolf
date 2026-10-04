import type { SwingResult } from "./analogSwing";

/**
 * Classic 3-click meter for putts and short shots.
 *
 *   click 1  the marker starts rising from 0 towards 100% power
 *   click 2  locks the power; the marker sweeps back towards the accuracy zone at 0
 *   click 3  sets accuracy: inside the zone is straight, early pulls/draws left,
 *            late pushes/fades right
 *
 * Missing click 2 (the marker falls back to 0) cancels; missing click 3 fires with the
 * worst accuracy. Time-based and free of DOM code so it can be unit-tested.
 */

export interface ThreeClickConfig {
  /** Seconds for the marker to rise from 0 to 100%. */
  riseTime: number;
  /** Seconds for the marker to return from the locked power to the zone (scaled down for low power). */
  returnTime: number;
  /** Half-width of the straight zone, as a fraction of full scale. */
  zone: number;
  /** pathDeg at the worst possible third click. */
  maxPathDeg: number;
}

/** Putts: slow, precise meter. pathDeg 16 turns into a ~2.4° start line miss for the putter. */
export const PUTT_METER: ThreeClickConfig = { riseTime: 1.8, returnTime: 0.9, zone: 0.04, maxPathDeg: 16 };
export const PITCH_METER: ThreeClickConfig = { riseTime: 1.5, returnTime: 0.8, zone: 0.04, maxPathDeg: 7 };

/** How far past the zone the marker travels before the shot fires on its own. */
export const OVERRUN = 0.15;

export type ThreeClickPhase = "idle" | "rising" | "falling" | "returning" | "done";

export class ThreeClickMeter {
  phase: ThreeClickPhase = "idle";
  /** Marker position: 0..1 is power, below 0 is the overrun past the accuracy zone. */
  marker = 0;
  power = 0;
  result: SwingResult | null = null;
  private returnSpeed = 1;

  constructor(public config: ThreeClickConfig) {}

  get active(): boolean {
    return this.phase === "rising" || this.phase === "falling" || this.phase === "returning";
  }

  reset() {
    this.phase = "idle";
    this.marker = 0;
    this.power = 0;
    this.result = null;
  }

  click() {
    switch (this.phase) {
      case "idle":
      case "done":
        this.reset();
        this.phase = "rising";
        break;
      case "rising":
      case "falling":
        this.power = Math.max(0.01, Math.min(1, this.marker));
        // Constant time back to the zone, but never so fast that short putts are a lottery.
        this.returnSpeed = Math.max(this.power, 0.35) / this.config.returnTime;
        this.phase = "returning";
        break;
      case "returning":
        this.finish(this.marker);
        break;
    }
  }

  update(dt: number) {
    if (this.phase === "rising") {
      this.marker += dt / this.config.riseTime;
      if (this.marker >= 1) {
        this.marker = 1;
        this.phase = "falling";
      }
    } else if (this.phase === "falling") {
      this.marker -= dt / this.config.riseTime;
      if (this.marker <= 0) this.reset();
    } else if (this.phase === "returning") {
      this.marker -= dt * this.returnSpeed;
      if (this.marker <= -OVERRUN) this.finish(-OVERRUN);
    }
  }

  private finish(at: number) {
    const { zone, maxPathDeg } = this.config;
    const off = Math.abs(at);
    const miss = Math.max(0, Math.min(1, (off - zone) / (OVERRUN - zone)));
    // Early (still above the zone) goes left; late (past it) goes right.
    const pathDeg = (at > 0 ? -1 : 1) * miss * maxPathDeg;
    this.marker = at;
    this.result = { power: this.power, tempo: 1, pathDeg: miss === 0 ? 0 : pathDeg };
    this.phase = "done";
  }
}
