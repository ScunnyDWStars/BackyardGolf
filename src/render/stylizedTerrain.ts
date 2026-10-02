import * as THREE from "three";
import type { TerrainModel } from "../course/terrain";
import type { CourseData, Lie, Polygon2 } from "../course/types";

/** Base colours for the painted lie map, tuned for the bright TW08 broadcast look. */
const LIE_COLORS: Record<Lie, [string, string]> = {
  rough: ["#3f6b26", "#3a6323"],
  fairway: ["#6fae3a", "#5f9c31"],
  tee: ["#78b842", "#6aa83a"],
  green: ["#7cc444", "#74ba3f"],
  bunker: ["#e3d3a4", "#d9c897"],
  water: ["#3d6f8e", "#365f7a"],
  "out-of-bounds": ["#35591f", "#30521c"],
};

const PAINT_ORDER: Lie[] = ["fairway", "tee", "green", "bunker", "water"];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paint the lie polygons into a canvas texture with mowing stripes along the hole. */
function paintLieMap(course: CourseData, holeIndex: number, pxPerMetre: number) {
  const hf = course.heightfield;
  const widthM = (hf.cols - 1) * hf.cellSize;
  const depthM = (hf.rows - 1) * hf.cellSize;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(4096, Math.ceil(widthM * pxPerMetre));
  canvas.height = Math.min(4096, Math.ceil(depthM * pxPerMetre));
  const sx = canvas.width / widthM;
  const sz = canvas.height / depthM;
  const ctx = canvas.getContext("2d")!;
  const hole = course.holes[holeIndex];

  const toPx = ([x, z]: [number, number]): [number, number] => [(x - hf.originX) * sx, (z - hf.originZ) * sz];
  const path = (poly: Polygon2) => {
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(...toPx(p)) : ctx.moveTo(...toPx(p))));
    ctx.closePath();
  };

  // Rough with mottled noise.
  ctx.fillStyle = LIE_COLORS.rough[0];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const rnd = mulberry32(7);
  for (let i = 0; i < (canvas.width * canvas.height) / 60; i++) {
    ctx.fillStyle = rnd() > 0.5 ? "rgba(20,40,10,0.10)" : "rgba(120,160,60,0.08)";
    const r = 1 + rnd() * 4;
    ctx.fillRect(rnd() * canvas.width, rnd() * canvas.height, r, r);
  }

  const [tx, tz] = hole.centerline.length > 1 ? hole.centerline[hole.centerline.length - 1] : [hole.pin.x, hole.pin.z];
  const angle = Math.atan2(tz - hole.tee.z, tx - hole.tee.x);

  for (const lie of PAINT_ORDER) {
    for (const area of hole.areas.filter((a) => a.lie === lie)) {
      const [c0, c1] = LIE_COLORS[lie];
      ctx.save();
      path(area.polygon);
      // Soft collar so edges read like a cut line rather than a hard vector edge.
      ctx.shadowColor = c0;
      ctx.shadowBlur = lie === "water" ? 2 : 6;
      ctx.fillStyle = c0;
      ctx.fill();
      ctx.clip();
      ctx.shadowBlur = 0;
      if (lie === "fairway" || lie === "green" || lie === "tee") {
        // Mowing stripes perpendicular to the line of play.
        const stripe = (lie === "green" ? 3 : 9) * sx;
        ctx.translate(...toPx([hole.tee.x, hole.tee.z]));
        ctx.rotate(angle);
        ctx.fillStyle = c1;
        for (let d = -4000; d < 4000; d += stripe * 2) ctx.fillRect(d, -4000, stripe, 8000);
      } else if (lie === "bunker") {
        for (let i = 0; i < 400; i++) {
          ctx.fillStyle = rnd() > 0.5 ? "rgba(255,255,255,0.15)" : "rgba(120,100,60,0.12)";
          const [bx, bz] = toPx(area.polygon[0]);
          ctx.fillRect(bx + (rnd() - 0.5) * 80 * sx, bz + (rnd() - 0.5) * 80 * sz, 2, 2);
        }
      }
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Heightfield mesh textured with the painted lie map, plus scattered trees. */
export function buildStylizedTerrain(course: CourseData, terrain: TerrainModel, holeIndex = 0): THREE.Group {
  const group = new THREE.Group();
  group.name = "stylized-terrain";
  const hf = course.heightfield;
  const widthM = (hf.cols - 1) * hf.cellSize;
  const depthM = (hf.rows - 1) * hf.cellSize;

  // Resample the heightfield at ~2 m so painted edges sit on smooth geometry.
  const seg = 2;
  const nx = Math.min(400, Math.ceil(widthM / seg));
  const nz = Math.min(400, Math.ceil(depthM / seg));
  const geo = new THREE.PlaneGeometry(widthM, depthM, nx, nz);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + hf.originX + widthM / 2;
    const z = pos.getZ(i) + hf.originZ + depthM / 2;
    pos.setXYZ(i, x, terrain.heightAt(x, z), z);
    uv.setXY(i, (x - hf.originX) / widthM, 1 - (z - hf.originZ) / depthM);
  }
  geo.computeVertexNormals();
  const map = paintLieMap(course, holeIndex, 4);
  map.flipY = true;
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map }));
  ground.receiveShadow = true;
  ground.name = "ground";
  group.add(ground);

  group.add(buildTrees(course, terrain, holeIndex));
  return group;
}

function buildTrees(course: CourseData, terrain: TerrainModel, holeIndex: number): THREE.Object3D {
  const hole = course.holes[holeIndex];
  const hf = course.heightfield;
  const rnd = mulberry32(42);
  const spots: THREE.Vector3[] = [];
  const minClear = 28; // metres from the centre line
  const distToCenter = (x: number, z: number) => {
    let best = Infinity;
    const cl = hole.centerline;
    for (let i = 0; i + 1 < cl.length; i++) {
      const [ax, az] = cl[i];
      const [bx, bz] = cl[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
    return best;
  };
  for (let i = 0; i < 6000 && spots.length < 700; i++) {
    const x = hf.originX + rnd() * (hf.cols - 1) * hf.cellSize;
    const z = hf.originZ + rnd() * (hf.rows - 1) * hf.cellSize;
    const d = distToCenter(x, z);
    if (d < minClear + rnd() * 25) continue;
    if (terrain.lieAt(x, z) !== "rough" && terrain.lieAt(x, z) !== "out-of-bounds") continue;
    spots.push(new THREE.Vector3(x, terrain.heightAt(x, z), z));
  }

  const crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 1, 6);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: 0x2f5a22 }), spots.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x4a3626 }), spots.length);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  spots.forEach((p, i) => {
    const h = 9 + rnd() * 8;
    const r = 3 + rnd() * 2.5;
    m.compose(new THREE.Vector3(p.x, p.y + h * 0.35, p.z), new THREE.Quaternion(), new THREE.Vector3(0.6, h * 0.7, 0.6));
    trunks.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(p.x, p.y + h * 0.7, p.z), new THREE.Quaternion(), new THREE.Vector3(r, h * 0.45, r));
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, color.setHSL(0.27 + rnd() * 0.05, 0.45, 0.2 + rnd() * 0.08));
  });
  crowns.castShadow = true;
  const group = new THREE.Group();
  group.name = "trees";
  group.add(trunks, crowns);
  return group;
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
