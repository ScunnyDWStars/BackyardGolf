import { TerrainModel } from "../course/terrain";
import type { CourseData, HoleData, Lie } from "../course/types";
import {
  type BallState,
  type Environment,
  type Launch,
  PHYSICS_DT,
  SURFACES,
  launchBall,
  simulate,
  step,
} from "../physics/ball";
import { type Vec3, add, headingOf, horizontalDistance, v3 } from "../math/vec3";
import { type LieModifier, type SwingResult, shotFromSwing } from "../swing/analogSwing";
import { CLUBS, type Club } from "./clubs";

export type SessionPhase = "address" | "flight" | "holed";

export interface ShotRecord {
  club: string;
  from: Vec3;
  to: Vec3;
  lie: Lie;
  carry: number;
  total: number;
  penalty?: "water" | "out-of-bounds";
}

/** 3-click meter range for short shots: 100 yards. */
export const THREE_CLICK_RANGE_M = 91.44;

const LIE_MODIFIERS: Partial<Record<Lie, LieModifier>> = {
  rough: { speed: 0.9, spin: 0.55 },
  bunker: { speed: 0.75, spin: 0.7 },
};

const FLAT_COURSE: CourseData = {
  name: "calibration",
  attribution: [],
  heightfield: { originX: -1000, originZ: -1000, cellSize: 100, cols: 21, rows: 21, heights: Array(441).fill(0) },
  bounds: [[-1000, -1000], [1000, -1000], [1000, 1000], [-1000, 1000]],
  holes: [{ number: 0, par: 4, lengthYards: 0, tee: v3(), pin: v3(0, 0, -3000), centerline: [], areas: [] }],
};

/** Full-power carry for each club on flat ground, no wind. Used for auto club selection
 * and the aim marker. */
export function carryTable(): Map<string, number> {
  const terrain = new TerrainModel(FLAT_COURSE);
  const env: Environment = { terrain, wind: v3(), pin: v3(0, 0, -3000) };
  const table = new Map<string, number>();
  for (const club of CLUBS) {
    if (club.isPutter) continue;
    const ball = launchBall(v3(), shotFromSwing(club, { power: 1, tempo: 1, pathDeg: 0 }, 0), "fairway");
    const { final } = simulate(ball, env);
    table.set(club.id, final.firstLanding ? -final.firstLanding.z : 0);
  }
  return table;
}

/** Game logic for playing one hole. Rendering and input live elsewhere. */
export class HoleSession {
  readonly terrain: TerrainModel;
  readonly hole: HoleData;
  readonly carries: Map<string, number>;
  phase: SessionPhase = "address";
  strokes = 0;
  ballPos: Vec3;
  lie: Lie = "tee";
  club: Club;
  aimHeading: number;
  wind: Vec3;
  ball: BallState | null = null;
  shots: ShotRecord[] = [];
  /** Set when the last shot came to rest; consumed by the UI. */
  lastResult: ShotRecord | null = null;
  private shotStart: Vec3 = v3();
  private accumulator = 0;

  constructor(
    readonly course: CourseData,
    holeIndex = 0,
    wind: Vec3 = v3(),
  ) {
    this.terrain = new TerrainModel(course, holeIndex);
    this.hole = course.holes[holeIndex];
    this.carries = carryTable();
    this.wind = wind;
    this.ballPos = this.groundAt(this.hole.tee);
    this.aimHeading = headingOf(this.ballPos, this.hole.pin);
    this.club = this.suggestClub();
  }

  get env(): Environment {
    return { terrain: this.terrain, wind: this.wind, pin: this.hole.pin };
  }

  get distanceToPin(): number {
    return horizontalDistance(this.ballPos, this.hole.pin);
  }

  groundAt(p: Vec3): Vec3 {
    return v3(p.x, this.terrain.heightAt(p.x, p.z), p.z);
  }

  /** Putter on the green; otherwise the shortest club whose full carry reaches the target. */
  suggestClub(): Club {
    if (this.lie === "green") return CLUBS[CLUBS.length - 1];
    const target = this.distanceToPin;
    const candidates = CLUBS.filter((c) => !c.isPutter && !(c.id === "1W" && this.lie !== "tee"));
    let best = candidates[0];
    for (const c of candidates) {
      if ((this.carries.get(c.id) ?? 0) >= target) best = c;
    }
    return best;
  }

  selectClub(delta: number) {
    const i = CLUBS.indexOf(this.club);
    this.club = CLUBS[Math.max(0, Math.min(CLUBS.length - 1, i + delta))];
  }

  /** Max putt distance at full power: comfortably past the hole. */
  get puttRange(): number {
    return Math.max(5, Math.ceil((this.distanceToPin * 1.25) / 5) * 5);
  }

  /** Expected landing spot for the current club at full power with no curve or wind. */
  aimPoint(power = 1): Vec3 {
    const d = this.club.isPutter
      ? this.puttRange * power
      : (this.carries.get(this.club.id) ?? 0) * power * (LIE_MODIFIERS[this.lie]?.speed ?? 1);
    const p = v3(
      this.ballPos.x + Math.sin(this.aimHeading) * d,
      0,
      this.ballPos.z - Math.cos(this.aimHeading) * d,
    );
    return this.groundAt(p);
  }

  /** 3-click is used for putts and anything within 100 yd, or for every shot if chosen. */
  usesThreeClick(allShots: boolean): boolean {
    return allShots || this.club.isPutter === true || this.distanceToPin <= THREE_CLICK_RANGE_M;
  }

  /** Ground point `distance` metres along the aim line. */
  pointAlongAim(distance: number): Vec3 {
    return this.groundAt(
      v3(this.ballPos.x + Math.sin(this.aimHeading) * distance, 0, this.ballPos.z - Math.cos(this.aimHeading) * distance),
    );
  }

  private solverKey = "";
  private solverCache: { scale: { power: number; distance: number }[]; ideal: number } | null = null;

  /** Where a straight shot at `power` comes to rest, measured along the aim line (metres).
   * Uses the real club, lie, wind and terrain (green slope); the cup never captures. */
  restDistance(power: number): number {
    const launch = this.launchFor({ power, tempo: 1, pathDeg: 0 });
    const start = add(this.ballPos, v3(0, 0.02, 0));
    const env = { terrain: this.terrain, wind: this.wind, pin: v3(1e9, 0, 1e9) };
    const { final } = simulate(launchBall(start, launch, this.lie), env, { maxTime: 30, sampleEvery: 1e9 });
    const dir = v3(Math.sin(this.aimHeading), 0, -Math.cos(this.aimHeading));
    return (final.pos.x - this.ballPos.x) * dir.x + (final.pos.z - this.ballPos.z) * dir.z;
  }

  private solve() {
    const key = `${this.club.id}|${this.lie}|${this.aimHeading.toFixed(4)}|${this.ballPos.x.toFixed(2)},${this.ballPos.z.toFixed(2)}|${this.wind.x},${this.wind.z}`;
    if (key === this.solverKey && this.solverCache) return this.solverCache;
    // Rest distance at 11 powers gives the meter's distance scale.
    const scale = Array.from({ length: 11 }, (_, i) => ({ power: i / 10, distance: i === 0 ? 0 : this.restDistance(i / 10) }));
    // Putts aim a little past the hole ("never up, never in"); other shots aim at it.
    const target = this.distanceToPin + (this.club.isPutter ? 0.25 : 0);
    let lo = 0;
    let hi = 1;
    if (scale[10].distance <= target) lo = hi = 1;
    else {
      // Bracket from the scale, then bisect with full simulations.
      for (let i = 1; i <= 10; i++) {
        if (scale[i].distance >= target) {
          lo = scale[i - 1].power;
          hi = scale[i].power;
          break;
        }
      }
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (this.restDistance(mid) < target) lo = mid;
        else hi = mid;
      }
    }
    this.solverKey = key;
    this.solverCache = { scale, ideal: (lo + hi) / 2 };
    return this.solverCache;
  }

  /** Power (0..1) that brings the ball to rest at the hole along the aim line. */
  idealPower(): number {
    return this.solve().ideal;
  }

  /** Rest distance (m) for each tenth of power, for meter ticks and readouts. */
  powerScale(): { power: number; distance: number }[] {
    return this.solve().scale;
  }

  /** Interpolated rest distance for any power, from the cached scale. */
  distanceAtPower(power: number): number {
    const sc = this.powerScale();
    const p = Math.max(0, Math.min(1, power)) * 10;
    const i = Math.min(9, Math.floor(p));
    return sc[i].distance + (sc[i + 1].distance - sc[i].distance) * (p - i);
  }

  launchFor(swing: SwingResult): Launch {
    return shotFromSwing(this.club, swing, this.aimHeading, {
      puttDistance: this.puttRange,
      greenDecel: SURFACES.green.rollDecel,
      lie: LIE_MODIFIERS[this.lie],
    });
  }

  hit(swing: SwingResult): Launch {
    if (this.phase !== "address") throw new Error(`cannot hit during ${this.phase}`);
    const launch = this.launchFor(swing);
    this.strokes += 1;
    this.shotStart = this.ballPos;
    // Tee the ball up slightly so the first physics step starts above the turf.
    const start = add(this.ballPos, v3(0, 0.02, 0));
    this.ball = launchBall(start, launch, this.lie);
    this.phase = "flight";
    this.accumulator = 0;
    this.lastResult = null;
    return launch;
  }

  /** Advance physics by real time; returns true when the ball came to rest this call. */
  update(dt: number): boolean {
    if (this.phase !== "flight" || !this.ball) return false;
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= PHYSICS_DT) {
      step(this.ball, this.env, PHYSICS_DT);
      this.accumulator -= PHYSICS_DT;
      if (this.ball.phase === "rest" || this.ball.phase === "holed") {
        this.resolve(this.ball);
        return true;
      }
    }
    return false;
  }

  /** Run the current shot to completion immediately (tests, skip button). */
  finishShot() {
    while (this.phase === "flight") this.update(0.1);
  }

  private resolve(ball: BallState) {
    const from = this.shotStart;
    const landing = ball.firstLanding ?? ball.pos;
    const record: ShotRecord = {
      club: this.club.id,
      from,
      to: ball.pos,
      lie: ball.lie,
      carry: horizontalDistance(from, landing),
      total: horizontalDistance(from, ball.pos),
    };

    if (ball.phase === "holed") {
      this.phase = "holed";
      this.ballPos = ball.pos;
      this.lie = "green";
    } else if (ball.lie === "water") {
      record.penalty = "water";
      this.strokes += 1;
      this.ballPos = this.dropOutside("water", from, ball.pos);
      this.lie = this.terrain.lieAt(this.ballPos.x, this.ballPos.z);
      this.phase = "address";
    } else if (ball.lie === "out-of-bounds") {
      record.penalty = "out-of-bounds";
      this.strokes += 1; // stroke and distance
      this.ballPos = from;
      this.lie = this.terrain.lieAt(from.x, from.z);
      this.phase = "address";
    } else {
      this.ballPos = ball.pos;
      this.lie = ball.lie;
      this.phase = "address";
    }
    this.shots.push(record);
    this.lastResult = record;
    this.ball = null;
    if (this.phase === "address") {
      this.aimHeading = headingOf(this.ballPos, this.hole.pin);
      this.club = this.suggestClub();
    }
  }

  /** Walk back from where the ball finished towards where it was hit until clear of the hazard. */
  private dropOutside(hazard: Lie, from: Vec3, to: Vec3): Vec3 {
    const total = horizontalDistance(from, to);
    for (let d = 0; d <= total; d += 0.5) {
      const f = total > 0 ? 1 - d / total : 0;
      const p = v3(from.x + (to.x - from.x) * f, 0, from.z + (to.z - from.z) * f);
      if (this.terrain.lieAt(p.x, p.z) !== hazard) {
        // Two club-lengths further back, per the rules of golf, but never past the start.
        const back = Math.min(total, d + 2);
        const g = total > 0 ? 1 - back / total : 0;
        return this.groundAt(v3(from.x + (to.x - from.x) * g, 0, from.z + (to.z - from.z) * g));
      }
    }
    return from;
  }
}
