import type { Club } from "../game/clubs";
import type { Launch } from "../physics/ball";

/**
 * TW08-style analog swing: press, pull the pointer straight back (down) for the
 * backswing, then push it straight forward (up) through the ball.
 *
 *  - Backswing depth sets power (1.0 = full; up to 1.1 is an overswing with extra
 *    distance and amplified error).
 *  - Downswing time is tempo: a stroke slower than the ideal loses power, whatever its
 *    length (so short putting strokes are not penalised for covering fewer pixels).
 *  - Sideways drift of the downswing curves the ball: drifting right starts it a
 *    little right and adds slice spin; drifting left draws/hooks it.
 */

export interface SwingSample {
  t: number; // seconds
  x: number; // px, +right
  y: number; // px, +down
}

export interface SwingResult {
  power: number; // 0..1.1
  tempo: number; // 0..1, 1 = ideal or faster
  pathDeg: number; // + = downswing drifted right
}

export interface SwingConfig {
  /** Backswing length in px that counts as a full (100%) swing. */
  fullSwingPx: number;
  /** Downswing duration (s) at or under which tempo is perfect. */
  idealDownswingTime: number;
}

export const defaultSwingConfig = (screenHeight: number): SwingConfig => ({
  fullSwingPx: Math.max(120, screenHeight * 0.28),
  idealDownswingTime: 0.25,
});

const MAX_POWER = 1.1;

export type SwingPhase = "idle" | "backswing" | "downswing" | "done";

/** Incremental tracker fed by pointer events. */
export class AnalogSwing {
  private samples: SwingSample[] = [];
  private bottomIndex = 0;
  phase: SwingPhase = "idle";
  result: SwingResult | null = null;

  constructor(private config: SwingConfig) {}

  isDone(): boolean {
    return this.phase === "done";
  }

  setConfig(config: SwingConfig) {
    this.config = config;
  }

  begin(s: SwingSample) {
    this.samples = [s];
    this.bottomIndex = 0;
    this.phase = "backswing";
    this.result = null;
  }

  /** Current backswing power, for the HUD meter. */
  get currentPower(): number {
    if (this.samples.length === 0) return 0;
    const start = this.samples[0];
    const bottom = this.samples[this.bottomIndex];
    return Math.min(MAX_POWER, Math.max(0, (bottom.y - start.y) / this.config.fullSwingPx));
  }

  move(s: SwingSample) {
    if (this.phase === "idle" || this.phase === "done") return;
    this.samples.push(s);
    const bottom = this.samples[this.bottomIndex];
    if (this.phase === "backswing") {
      if (s.y >= bottom.y) {
        this.bottomIndex = this.samples.length - 1;
      } else if (bottom.y - s.y > this.config.fullSwingPx * 0.06) {
        this.phase = "downswing";
      }
    }
    if (this.phase === "downswing") {
      const start = this.samples[0];
      // Contact once the pointer comes back past the address position.
      if (s.y <= start.y) this.finish();
    }
  }

  /** Pointer released: completes a downswing, or cancels a swing that never started down. */
  end(s: SwingSample) {
    if (this.phase === "downswing") {
      this.samples.push(s);
      this.finish();
    } else if (this.phase === "backswing") {
      this.phase = "idle";
    }
  }

  private finish() {
    this.result = evaluateSwing(this.samples, this.bottomIndex, this.config);
    this.phase = "done";
  }
}

export function evaluateSwing(
  samples: SwingSample[],
  bottomIndex: number,
  config: SwingConfig,
): SwingResult {
  const start = samples[0];
  const bottom = samples[bottomIndex];
  const end = samples[samples.length - 1];
  const depth = bottom.y - start.y;
  const rawPower = Math.max(0, depth / config.fullSwingPx);
  const power = Math.min(MAX_POWER, rawPower);

  const downDy = bottom.y - end.y;
  const downDt = Math.max(1e-3, end.t - bottom.t);
  const tempo = Math.min(1, config.idealDownswingTime / downDt);

  // Lateral drift through the downswing, measured against the stroke's own length so the
  // same wrist wobble matters less on a long swing.
  const drift = end.x - bottom.x;
  const pathDeg = (Math.atan2(drift, Math.max(downDy, 1)) * 180) / Math.PI;
  return { power, tempo, pathDeg };
}

/** Lie penalties applied to a full shot: rough flyers lose spin, sand loses speed. */
export interface LieModifier {
  speed: number;
  spin: number;
}

export function shotFromSwing(
  club: Club,
  swing: SwingResult,
  aimHeading: number,
  opts: { puttDistance?: number; greenDecel?: number; lie?: LieModifier } = {},
): Launch {
  const lie = opts.lie ?? { speed: 1, spin: 1 };
  // Slow tempo bleeds up to 30% of the speed.
  const tempoLoss = 0.7 + 0.3 * swing.tempo;
  // Overswing amplifies curvature errors.
  const errorGain = swing.power > 1 ? 1 + (swing.power - 1) * 6 : 1;
  const path = swing.pathDeg * errorGain;

  if (club.isPutter) {
    // Putts: power maps linearly to roll distance on a flat green at this pace.
    const decel = opts.greenDecel ?? 0.55;
    const range = opts.puttDistance ?? 10;
    const dist = Math.max(0, swing.power) * range;
    return {
      speed: Math.sqrt(2 * decel * dist) * tempoLoss,
      launchDeg: 0,
      heading: aimHeading + ((path * 0.15) * Math.PI) / 180,
      backspinRpm: 0,
      sidespinRpm: 0,
    };
  }

  // Partial swings: carry grows roughly with speed^2 (less with drag), so speed ~ power^0.6
  // makes the meter read linearly in distance, like TW08's.
  const powerSpeed = swing.power <= 1 ? Math.pow(swing.power, 0.6) : 1 + (swing.power - 1) * 0.5;
  const speed = club.ballSpeed * powerSpeed * tempoLoss * lie.speed;
  // Spin scales with ball speed: a soft chip with a wedge spins far less than a full swing.
  const backspin = club.backspinRpm * Math.min(1, powerSpeed) * lie.spin;
  const sidespin = Math.max(-3500, Math.min(3500, path * 220));
  return {
    speed,
    launchDeg: club.launchDeg * (0.85 + 0.15 * Math.min(1, swing.power)),
    heading: aimHeading + (path * 0.25 * Math.PI) / 180,
    backspinRpm: backspin,
    sidespinRpm: sidespin,
  };
}
