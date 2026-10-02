import * as THREE from "three";
import type { TerrainModel } from "../course/terrain";
import type { CourseData } from "../course/types";
import { buildCourseLook } from "./courseLook";

/** The stylized course (ground, water, trees, tee markers); see courseLook.ts. */
export function buildStylizedTerrain(course: CourseData, terrain: TerrainModel, sunDir = new THREE.Vector3(-120, 200, 80).normalize()): THREE.Group {
  return buildCourseLook(course, terrain, sunDir);
}

export function buildPin(pin: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 2.13, 8),
    new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }),
  );
  pole.position.y = 1.065;
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.35),
    new THREE.MeshLambertMaterial({ color: 0xd8262b, side: THREE.DoubleSide }),
  );
  flag.position.set(0.25, 1.95, 0);
  const cup = new THREE.Mesh(new THREE.CircleGeometry(0.054, 24), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  cup.rotation.x = -Math.PI / 2;
  cup.position.y = 0.005;
  g.add(pole, flag, cup);
  g.position.copy(pin);
  g.name = "pin";
  return g;
}

export function buildBall(): THREE.Mesh {
  // Drawn larger than life so it stays readable at broadcast camera distances.
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
  ball.castShadow = true;
  ball.name = "ball";
  return ball;
}

/** Target ring and dashed flight arc showing the projected landing spot. */
export class AimMarker {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private arc: THREE.Line;

  constructor() {
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.1, 40),
      new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 10;
    this.arc = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.arc.renderOrder = 10;
    this.group.add(this.ring, this.arc);
  }

  update(from: THREE.Vector3, to: THREE.Vector3, apex: number, ringScale: number) {
    this.ring.position.copy(to).add(new THREE.Vector3(0, 0.05, 0));
    this.ring.scale.setScalar(ringScale);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const p = from.clone().lerp(to, t);
      p.y += 4 * apex * t * (1 - t);
      pts.push(p);
    }
    this.arc.geometry.setFromPoints(pts);
    this.arc.computeLineDistances();
  }
}

/** Terrain-hugging grid over the green, tinted by slope like TW08's putting grid. */
export function buildPuttingGrid(terrain: TerrainModel, center: THREE.Vector3, radius = 14, step = 1): THREE.LineSegments {
  const pts: number[] = [];
  const cols: number[] = [];
  const c = new THREE.Color();
  const push = (x: number, z: number) => {
    const n = terrain.normalAt(x, z);
    const slope = Math.min(1, Math.hypot(n.x, n.z) / 0.04);
    c.setHSL(0.55 - 0.55 * slope, 0.9, 0.6);
    pts.push(x, terrain.heightAt(x, z) + 0.03, z);
    cols.push(c.r, c.g, c.b);
  };
  for (let a = -radius; a <= radius; a += step) {
    for (let b = -radius; b < radius; b += step / 2) {
      if (Math.hypot(a, b) > radius || Math.hypot(a, b + step / 2) > radius) continue;
      push(center.x + a, center.z + b);
      push(center.x + a, center.z + b + step / 2);
      push(center.x + b, center.z + a);
      push(center.x + b + step / 2, center.z + a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  const grid = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
  grid.name = "putting-grid";
  return grid;
}
