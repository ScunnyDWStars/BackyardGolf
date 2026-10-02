import type { Lie } from "../course/types";
import type { TerrainModel } from "../course/terrain";
import {
  type Vec3,
  add,
  cross,
  dot,
  headingVector,
  length,
  normalize,
  scale,
  sub,
  v3,
} from "../math/vec3";

// Regulation ball and standard air.
export const BALL_MASS = 0.04593; // kg
export const BALL_RADIUS = 0.02135; // m
const AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
const AIR_DENSITY = 1.225; // kg/m^3
const GRAVITY = v3(0, -9.81, 0);
export const CUP_RADIUS = 0.054; // m
export const RPM = (2 * Math.PI) / 60;

/** Per-lie ground response. */
interface Surface {
  restitution: number; // normal bounce coefficient
  grip: number; // 0..1: how fully friction converts slip into rolling on impact
  rollDecel: number; // rolling resistance, m/s^2 (green 0.55 ~ stimp 10)
}

export const SURFACES: Record<Lie, Surface> = {
  tee: { restitution: 0.35, grip: 0.6, rollDecel: 2.4 },
  fairway: { restitution: 0.35, grip: 0.6, rollDecel: 2.4 },
  green: { restitution: 0.25, grip: 0.85, rollDecel: 0.55 },
  rough: { restitution: 0.2, grip: 0.8, rollDecel: 4.5 },
  bunker: { restitution: 0.05, grip: 1, rollDecel: 10 },
  water: { restitution: 0, grip: 1, rollDecel: 100 },
  "out-of-bounds": { restitution: 0.3, grip: 0.7, rollDecel: 3 },
};

/** Aerodynamic coefficients from spin factor S = r*omega/v, tuned so full shots match
 * tour launch-monitor carries (see tests/ball.test.ts). */
export function dragCoefficient(spinFactor: number): number {
  return 0.2 + 0.3 * spinFactor;
}
export function liftCoefficient(spinFactor: number): number {
  const s = Math.min(spinFactor, 0.3);
  return Math.max(0, 1.99 * s - 3.25 * s * s);
}

export interface Launch {
  /** Ball speed, m/s. */
  speed: number;
  /** Vertical launch angle, degrees. */
  launchDeg: number;
  /** Heading in radians (0 = -Z), already including any push/pull. */
  heading: number;
  /** Backspin, rpm. */
  backspinRpm: number;
  /** Sidespin, rpm; positive curves right (fade/slice for a right-hander). */
  sidespinRpm: number;
}

export type Phase = "air" | "roll" | "rest" | "holed";

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  /** Angular velocity, rad/s. */
  spin: Vec3;
  phase: Phase;
  lie: Lie;
  /** Where the ball first touched the ground on this shot. */
  firstLanding?: Vec3;
  time: number;
}

export function launchBall(pos: Vec3, launch: Launch, lie: Lie): BallState {
  const dir = headingVector(launch.heading);
  const right = cross(dir, v3(0, 1, 0));
  const elev = (launch.launchDeg * Math.PI) / 180;
  const vel = add(scale(dir, launch.speed * Math.cos(elev)), v3(0, launch.speed * Math.sin(elev), 0));
  // Backspin turns about the golfer's right axis; positive sidespin turns about -up.
  const spin = add(scale(right, launch.backspinRpm * RPM), v3(0, -launch.sidespinRpm * RPM, 0));
  const phase: Phase = launch.launchDeg > 0.5 ? "air" : "roll";
  return { pos, vel, spin, phase, lie, time: 0 };
}

export interface Environment {
  terrain: TerrainModel;
  wind: Vec3;
  pin: Vec3;
}

const SPIN_DECAY_PER_S = 0.04;
const ROLL_THRESHOLD = 0.6; // m/s of normal speed below which a bounce becomes a roll
const REST_SPEED = 0.04;
const CUP_CAPTURE_SPEED = 1.6; // m/s; faster putts lip out

function airAccel(state: BallState, wind: Vec3): Vec3 {
  const rel = sub(state.vel, wind);
  const speed = length(rel);
  if (speed < 1e-6) return GRAVITY;
  const omega = length(state.spin);
  const s = (BALL_RADIUS * omega) / speed;
  const k = (0.5 * AIR_DENSITY * AREA) / BALL_MASS;
  const drag = scale(rel, -k * dragCoefficient(s) * speed);
  let lift = v3();
  if (omega > 1e-6) {
    const dir = normalize(cross(state.spin, rel));
    lift = scale(dir, k * liftCoefficient(s) * speed * speed);
  }
  return add(GRAVITY, add(drag, lift));
}

function bounce(state: BallState, env: Environment): void {
  const { terrain } = env;
  const n = terrain.normalAt(state.pos.x, state.pos.z);
  const lie = terrain.lieAt(state.pos.x, state.pos.z);
  state.lie = lie;
  state.pos = v3(state.pos.x, terrain.heightAt(state.pos.x, state.pos.z), state.pos.z);
  state.firstLanding ??= state.pos;

  if (lie === "water") {
    state.vel = v3();
    state.spin = v3();
    state.phase = "rest";
    return;
  }

  const surf = SURFACES[lie];
  const vn = dot(state.vel, n);
  const vt = sub(state.vel, scale(n, vn));
  // Rolling-without-slip target for a solid sphere: v = (5 v_t + 2 r (omega x n)) / 7.
  // Backspin makes (omega x n) point backwards, so high-spin wedges check up.
  const spinTerm = scale(cross(state.spin, n), BALL_RADIUS);
  const rolling = scale(add(scale(vt, 5), scale(spinTerm, 2)), 1 / 7);
  let newVt = add(scale(vt, 1 - surf.grip), scale(rolling, surf.grip));
  // Spin can check a ball up and draw it back a little, but never fire it back faster than
  // a fifth of its incoming speed (real wedges "zip back" a few yards at most).
  const along = dot(newVt, normalize(vt));
  if (along < 0) newVt = sub(newVt, scale(normalize(vt), along + Math.min(-along, 0.2 * length(vt))));
  const newVn = -vn * surf.restitution;
  state.vel = add(newVt, scale(n, Math.abs(newVn)));
  state.spin = scale(state.spin, 0.35);
  if (Math.abs(newVn) < ROLL_THRESHOLD) {
    state.phase = "roll";
    state.vel = newVt;
  }
}

function rollStep(state: BallState, env: Environment, dt: number): void {
  const { terrain } = env;
  const n = terrain.normalAt(state.pos.x, state.pos.z);
  const lie = terrain.lieAt(state.pos.x, state.pos.z);
  state.lie = lie;
  if (lie === "water") {
    state.vel = v3();
    state.phase = "rest";
    return;
  }
  const decel = SURFACES[lie].rollDecel;
  const gTangent = sub(GRAVITY, scale(n, dot(GRAVITY, n)));
  const speed = length(state.vel);

  if (speed < REST_SPEED && length(gTangent) < decel * 1.2) {
    state.vel = v3();
    state.phase = "rest";
    return;
  }
  let accel = gTangent;
  if (speed > 1e-6) accel = add(accel, scale(state.vel, -decel / speed));
  let vel = add(state.vel, scale(accel, dt));
  // Friction cannot reverse the ball on its own: clamp when it would flip direction.
  if (speed > 1e-6 && dot(vel, state.vel) < 0 && length(gTangent) < decel) vel = v3();
  // Keep velocity on the ground plane.
  vel = sub(vel, scale(n, dot(vel, n)));
  const next = add(state.pos, scale(vel, dt));
  state.pos = v3(next.x, terrain.heightAt(next.x, next.z), next.z);
  state.vel = vel;
  state.spin = scale(state.spin, Math.exp(-3 * dt));

  const toPin = Math.hypot(state.pos.x - env.pin.x, state.pos.z - env.pin.z);
  if (lie === "green" && toPin < CUP_RADIUS && length(vel) < CUP_CAPTURE_SPEED) {
    state.pos = v3(env.pin.x, env.pin.y - 0.08, env.pin.z);
    state.vel = v3();
    state.phase = "holed";
  }
}

/** Advance the ball by one fixed step. */
export function step(state: BallState, env: Environment, dt: number): void {
  if (state.phase === "rest" || state.phase === "holed") return;
  state.time += dt;
  if (state.phase === "air") {
    // Semi-implicit Euler is plenty at 240 Hz.
    state.vel = add(state.vel, scale(airAccel(state, env.wind), dt));
    state.pos = add(state.pos, scale(state.vel, dt));
    state.spin = scale(state.spin, Math.exp(-SPIN_DECAY_PER_S * dt));
    if (env.terrain.clearance(state.pos) <= 0) bounce(state, env);
  } else {
    rollStep(state, env, dt);
  }
  if (state.time > 60) state.phase = "rest";
}

export const PHYSICS_DT = 1 / 240;

/** Run a shot to completion. Returns the final state and the sampled path. */
export function simulate(
  start: BallState,
  env: Environment,
  opts: { maxTime?: number; sampleEvery?: number } = {},
): { final: BallState; path: Vec3[] } {
  const state = { ...start };
  const path: Vec3[] = [state.pos];
  const sampleEvery = opts.sampleEvery ?? 8;
  const maxSteps = Math.ceil((opts.maxTime ?? 60) / PHYSICS_DT);
  for (let i = 0; i < maxSteps && state.phase !== "rest" && state.phase !== "holed"; i++) {
    step(state, env, PHYSICS_DT);
    if (i % sampleEvery === 0) path.push(state.pos);
  }
  path.push(state.pos);
  return { final: state, path };
}
