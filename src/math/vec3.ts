/** Small immutable-style 3D vector used by game logic (kept free of Three.js for testing). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : v3();
};
export const horizontalDistance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Unit vector on the ground plane for a heading in radians (0 = -Z, positive = towards +X). */
export const headingVector = (heading: number): Vec3 => v3(Math.sin(heading), 0, -Math.cos(heading));
export const headingOf = (from: Vec3, to: Vec3): number => Math.atan2(to.x - from.x, -(to.z - from.z));
