import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { pointInPolygon } from "../course/terrain";
import type { TerrainModel } from "../course/terrain";
import type { Area, CourseData, Polygon2 } from "../course/types";

/**
 * Stylized course look in the spirit of modern "toy-real" golf games: crisp mowing
 * patterns computed per pixel in world space (so they stay sharp at the ball), soft
 * cut lines between rough, first cut, fairway, collar and green, sand with a shaded lip,
 * glassy water and rounded clump-canopy trees with soft blob shadows.
 *
 * Lie polygons are rasterised once into two small mask textures; everything else is
 * procedural in the ground shader.
 */

const PALETTE = {
  rough: "#3d7a2b",
  roughDark: "#2f6522",
  firstCut: "#5a9a36",
  fairway: "#74b63e",
  fairwayLight: "#86c64a",
  collar: "#6cb43f",
  green: "#86cf4c",
  greenLight: "#97da5a",
  tee: "#7cc044",
  teeLight: "#8ccd50",
  sand: "#efe0b4",
  sandShade: "#d4bf8a",
  bank: "#4c6a35",
  waterBed: "#2d5f6f",
};

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allAreas(course: CourseData): Area[] {
  return [...(course.areas ?? []), ...course.holes.flatMap((h) => h.areas)];
}

function centroid(poly: Polygon2): [number, number] {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / poly.length, z / poly.length];
}

/** Direction of play at the point of a hole's centre line nearest to (x, z). */
function playDirection(course: CourseData, x: number, z: number, preferEnd: boolean): [number, number] {
  let best = Infinity;
  let dir: [number, number] = [0, -1];
  for (const hole of course.holes) {
    const cl = hole.centerline.length > 1 ? hole.centerline : [[hole.tee.x, hole.tee.z], [hole.pin.x, hole.pin.z]];
    for (let i = 0; i + 1 < cl.length; i++) {
      const [ax, az] = cl[i];
      const [bx, bz] = cl[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
      if (d < best) {
        best = d;
        const L = Math.sqrt(len2);
        dir = [dx / L, dz / L];
      }
    }
    if (preferEnd && Math.hypot(x - hole.pin.x, z - hole.pin.z) < 60) {
      const [ax, az] = cl[cl.length - 2];
      const [bx, bz] = cl[cl.length - 1];
      const L = Math.hypot(bx - ax, bz - az) || 1;
      return [(bx - ax) / L, (bz - az) / L];
    }
  }
  return dir;
}

interface Masks {
  lies: THREE.DataTexture; // R fairway, G green, B bunker, A water
  aux: THREE.DataTexture; // R tee, G woods, BA mowing direction
  origin: THREE.Vector2;
  size: THREE.Vector2;
}

/** Rasterise lie polygons (anti-aliased by canvas) into packed RGBA data textures. */
function buildMasks(course: CourseData): Masks {
  const hf = course.heightfield;
  const widthM = (hf.cols - 1) * hf.cellSize;
  const depthM = (hf.rows - 1) * hf.cellSize;
  const metresPerPx = Math.max(0.5, Math.max(widthM, depthM) / 3072);
  const w = Math.ceil(widthM / metresPerPx);
  const h = Math.ceil(depthM / metresPerPx);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const toPx = ([x, z]: [number, number]): [number, number] => [(x - hf.originX) / metresPerPx, (z - hf.originZ) / metresPerPx];
  const path = (poly: Polygon2) => {
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(...toPx(p)) : ctx.moveTo(...toPx(p))));
    ctx.closePath();
  };
  const areas = allAreas(course);
  const paint = (polys: Polygon2[]) => {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    for (const p of polys) {
      path(p);
      ctx.fill();
    }
    return ctx.getImageData(0, 0, w, h).data;
  };
  const byLie = (lie: string) => areas.filter((a) => a.lie === lie).map((a) => a.polygon);

  const lies = new Uint8Array(w * h * 4);
  const aux = new Uint8Array(w * h * 4);
  const channels: [Uint8Array, number, Polygon2[]][] = [
    [lies, 0, byLie("fairway")],
    [lies, 1, byLie("green")],
    [lies, 2, byLie("bunker")],
    [lies, 3, byLie("water")],
    [aux, 0, byLie("tee")],
    [aux, 1, (course.features?.woods ?? []).map((wd) => wd.polygon)],
  ];
  for (const [target, ch, polys] of channels) {
    const img = paint(polys);
    for (let i = 0; i < w * h; i++) target[i * 4 + ch] = img[i * 4];
  }

  // Mowing direction per mown area, from the hole it belongs to.
  ctx.fillStyle = "rgb(128,0,128)";
  ctx.fillRect(0, 0, w, h);
  for (const a of areas) {
    if (a.lie !== "fairway" && a.lie !== "green" && a.lie !== "tee") continue;
    const [cx, cz] = centroid(a.polygon);
    const [dx, dz] = playDirection(course, cx, cz, a.lie === "green");
    ctx.fillStyle = `rgb(${Math.round((dx * 0.5 + 0.5) * 255)},0,${Math.round((dz * 0.5 + 0.5) * 255)})`;
    path(a.polygon);
    ctx.fill();
  }
  const dirImg = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < w * h; i++) {
    aux[i * 4 + 2] = dirImg[i * 4];
    aux[i * 4 + 3] = dirImg[i * 4 + 2];
  }

  const tex = (data: Uint8Array) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  return {
    lies: tex(lies),
    aux: tex(aux),
    origin: new THREE.Vector2(hf.originX, hf.originZ),
    size: new THREE.Vector2(w * metresPerPx, h * metresPerPx),
  };
}

const GROUND_FRAGMENT = /* glsl */ `
  vec2 cuv = (vWorldPos.xz - uOrigin) / uSize;
  vec4 L = texture2D(uLies, cuv);
  vec4 Lb = texture2D(uLies, cuv, 3.0);   // mip-biased lookup = soft halo around each area
  vec4 X = texture2D(uAux, cuv);
  vec2 dir = X.zw * 2.0 - 1.0;
  dir = length(dir) > 0.2 ? normalize(dir) : vec2(0.0, -1.0);
  vec2 xz = vWorldPos.xz;

  float n = gNoise(xz * 0.07) * 0.6 + gNoise(xz * 0.31) * 0.4;
  vec3 col = mix(cRoughDark, cRough, n);
  col *= 1.0 - 0.28 * smoothstep(0.2, 0.9, texture2D(uAux, cuv, 2.0).g);  // shade under woods

  float fwy = smoothstep(0.42, 0.58, L.r);
  float grn = smoothstep(0.42, 0.58, L.g);
  float bun = smoothstep(0.42, 0.58, L.b);
  float wat = smoothstep(0.42, 0.58, L.a);
  float tee = smoothstep(0.42, 0.58, X.r);

  // First cut around fairways and the collar around greens.
  col = mix(col, cFirstCut, smoothstep(0.04, 0.22, max(Lb.r, Lb.b * 0.6)) * (1.0 - fwy));
  col = mix(col, cCollar, smoothstep(0.05, 0.25, Lb.g) * (1.0 - grn));

  // Mowing bands across the line of play.
  float s = dot(xz, dir) / 9.0;
  float band = clamp((abs(fract(s) - 0.5) - 0.25) / max(fwidth(s), 1e-3) + 0.5, 0.0, 1.0);
  col = mix(col, mix(cFairway, cFairwayLight, band) * (0.96 + 0.08 * n), fwy);
  col = mix(col, mix(cTee, cTeeLight, band), tee);

  // Greens: fine checkerboard.
  vec2 g = vec2(dot(xz, dir), dot(xz, vec2(-dir.y, dir.x))) / 3.2;
  vec2 gw = max(fwidth(g), vec2(1e-3));
  vec2 gb = clamp((abs(fract(g) - 0.5) - 0.25) / gw + 0.5, 0.0, 1.0);
  float checker = abs(gb.x - gb.y);
  col = mix(col, mix(cGreen, cGreenLight, checker), grn);

  // Bunkers: darker grass lip outside, shaded sand edge inside.
  col *= 1.0 - 0.18 * smoothstep(0.05, 0.35, Lb.b) * (1.0 - bun);
  vec3 sand = mix(cSandShade, cSand, smoothstep(0.55, 0.95, L.b)) * (0.97 + 0.06 * gNoise(xz * 1.7));
  col = mix(col, sand, bun);

  // Water bed and muddy bank (the water surface is a separate mesh above).
  col = mix(col, cBank, smoothstep(0.05, 0.4, Lb.a) * (1.0 - wat) * 0.55);
  col = mix(col, cWaterBed, wat);

  diffuseColor.rgb = col;
`;

const GROUND_HEADER = /* glsl */ `
  varying vec3 vWorldPos;
  uniform sampler2D uLies;
  uniform sampler2D uAux;
  uniform vec2 uOrigin;
  uniform vec2 uSize;
  uniform vec3 cRough, cRoughDark, cFirstCut, cFairway, cFairwayLight, cCollar, cGreen, cGreenLight,
    cTee, cTeeLight, cSand, cSandShade, cBank, cWaterBed;
  float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float gNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
  }
`;

function groundMaterial(masks: Masks): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const colorUniforms = Object.fromEntries(
    Object.entries(PALETTE).map(([k, hex]) => [`c${k[0].toUpperCase()}${k.slice(1)}`, { value: new THREE.Color(hex) }]),
  );
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, colorUniforms, {
      uLies: { value: masks.lies },
      uAux: { value: masks.aux },
      uOrigin: { value: masks.origin },
      uSize: { value: masks.size },
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${GROUND_HEADER}`)
      .replace("#include <map_fragment>", GROUND_FRAGMENT);
  };
  mat.customProgramCacheKey = () => "course-ground-v1";
  return mat;
}

function buildGroundMesh(course: CourseData, terrain: TerrainModel, masks: Masks): THREE.Mesh {
  const hf = course.heightfield;
  const widthM = (hf.cols - 1) * hf.cellSize;
  const depthM = (hf.rows - 1) * hf.cellSize;
  // About 2 m between vertices, capped so big courses stay light on phones.
  const seg = Math.max(2, Math.sqrt((widthM * depthM) / 220_000));
  const nx = Math.ceil(widthM / seg);
  const nz = Math.ceil(depthM / seg);
  const geo = new THREE.PlaneGeometry(widthM, depthM, nx, nz);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + hf.originX + widthM / 2;
    const z = pos.getZ(i) + hf.originZ + depthM / 2;
    pos.setXYZ(i, x, terrain.heightAt(x, z), z);
  }
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, groundMaterial(masks));
  ground.receiveShadow = true;
  ground.name = "ground";
  return ground;
}

function buildWater(course: CourseData, terrain: TerrainModel): THREE.Object3D {
  const group = new THREE.Group();
  group.name = "water";
  const mat = new THREE.MeshPhongMaterial({
    color: 0x2f88c2,
    specular: 0xbfe3ff,
    shininess: 90,
    transparent: true,
    opacity: 0.86,
    side: THREE.DoubleSide,
  });
  for (const a of allAreas(course)) {
    if (a.lie !== "water") continue;
    let rim = Infinity;
    for (let i = 0; i < a.polygon.length; i++) {
      const [ax, az] = a.polygon[i];
      const [bx, bz] = a.polygon[(i + 1) % a.polygon.length];
      for (let t = 0; t < 1; t += 0.25) rim = Math.min(rim, terrain.heightAt(ax + (bx - ax) * t, az + (bz - az) * t));
    }
    const shape = new THREE.Shape(a.polygon.map(([x, z]) => new THREE.Vector2(x, z)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = rim - 0.25;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------- trees

type TreeKind = "broadleaf" | "conifer" | "bush";
interface TreeSpot {
  x: number;
  z: number;
  kind: TreeKind;
}

function blobCanopy(): THREE.BufferGeometry {
  const blobs: [number, number, number, number][] = [
    [0, 0, 0, 1],
    [0.62, 0.18, 0.28, 0.74],
    [-0.58, 0.12, -0.22, 0.72],
    [0.08, 0.5, -0.5, 0.66],
    [-0.18, 0.42, 0.55, 0.62],
  ];
  const parts = blobs.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 2);
    g.translate(x, y, z);
    return g;
  });
  return shadeByHeight(mergeGeometries(parts)!, "#2c5a1e", "#6aa53a");
}

function coniferCanopy(): THREE.BufferGeometry {
  const tiers = [0, 0.55, 1.05].map((y, i) => {
    const g = new THREE.ConeGeometry(0.95 - i * 0.22, 1.1, 9);
    g.translate(0, y, 0);
    return g;
  });
  return shadeByHeight(mergeGeometries(tiers)!, "#1f4a26", "#4f8a43");
}

/** Bake a bottom-dark, top-light gradient into vertex colours (cheap ambient occlusion). */
function shadeByHeight(geo: THREE.BufferGeometry, bottom: string, top: string): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox!;
  const pos = geo.attributes.position;
  const a = new THREE.Color(bottom);
  const b = new THREE.Color(top);
  const c = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - min.y) / (max.y - min.y || 1);
    c.copy(a).lerp(b, Math.pow(t, 0.8)).toArray(colors, i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

function blobShadowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function treeSpots(course: CourseData, terrain: TerrainModel): TreeSpot[] {
  const rnd = mulberry32(42);
  const spots: TreeSpot[] = [];
  const f = course.features;
  const playable = allAreas(course).filter((a) => a.lie !== "rough");
  const clear = (x: number, z: number) => !playable.some((a) => pointInPolygon(x, z, a.polygon));
  const push = (x: number, z: number, kind: TreeKind) => {
    if (clear(x, z)) spots.push({ x, z, kind });
  };

  for (const [x, z] of f?.trees ?? []) push(x, z, rnd() < 0.2 ? "conifer" : "broadleaf");
  for (const row of f?.treeRows ?? []) {
    for (let i = 0; i + 1 < row.length; i++) {
      const [ax, az] = row[i];
      const [bx, bz] = row[i + 1];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 7));
      for (let k = 0; k <= n; k++) push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, "broadleaf");
    }
  }
  for (const wood of f?.woods ?? []) {
    const spacing = wood.kind === "wood" ? 7.5 : 4.5;
    const xs = wood.polygon.map((p) => p[0]);
    const zs = wood.polygon.map((p) => p[1]);
    for (let x = Math.min(...xs); x < Math.max(...xs); x += spacing) {
      for (let z = Math.min(...zs); z < Math.max(...zs); z += spacing) {
        const jx = x + (rnd() - 0.5) * spacing * 0.9;
        const jz = z + (rnd() - 0.5) * spacing * 0.9;
        if (!pointInPolygon(jx, jz, wood.polygon)) continue;
        push(jx, jz, wood.kind === "scrub" ? "bush" : rnd() < 0.25 ? "conifer" : "broadleaf");
      }
    }
  }

  // Courses without mapped trees get lines of trees along the holes, clear of play.
  if (spots.length === 0) {
    const hf = course.heightfield;
    for (let i = 0; i < 9000 && spots.length < 700; i++) {
      const x = hf.originX + rnd() * (hf.cols - 1) * hf.cellSize;
      const z = hf.originZ + rnd() * (hf.rows - 1) * hf.cellSize;
      const d = Math.min(...course.holes.map((h) => distToLine(x, z, h.centerline)));
      if (d < 30 + rnd() * 25 || terrain.lieAt(x, z) !== "rough") continue;
      push(x, z, rnd() < 0.25 ? "conifer" : "broadleaf");
    }
  }
  return spots.slice(0, 7000);
}

function distToLine(x: number, z: number, cl: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < cl.length; i++) {
    const [ax, az] = cl[i];
    const [bx, bz] = cl[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

function buildTrees(course: CourseData, terrain: TerrainModel, sunDir: THREE.Vector3): THREE.Group {
  const spots = treeSpots(course, terrain);
  const rnd = mulberry32(7);
  const group = new THREE.Group();
  group.name = "trees";
  const canopyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4030 });
  const kinds: TreeKind[] = ["broadleaf", "conifer", "bush"];
  const geos: Record<TreeKind, THREE.BufferGeometry> = {
    broadleaf: blobCanopy(),
    conifer: coniferCanopy(),
    bush: blobCanopy(),
  };
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 7);
  trunkGeo.translate(0, 0.5, 0);
  const shadowGeo = new THREE.PlaneGeometry(2, 2);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false });
  const shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, spots.length);
  shadows.renderOrder = 1;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tint = new THREE.Color();
  const shadowOffset = new THREE.Vector2(-sunDir.x, -sunDir.z).normalize();
  let trunkCount = 0;

  for (const kind of kinds) {
    const mine = spots.map((s, idx) => ({ s, idx })).filter(({ s }) => s.kind === kind);
    if (!mine.length) continue;
    const canopies = new THREE.InstancedMesh(geos[kind], canopyMat, mine.length);
    canopies.castShadow = true;
    mine.forEach(({ s, idx }, i) => {
      const y = terrain.heightAt(s.x, s.z);
      const scale = kind === "bush" ? 1.2 + rnd() * 0.8 : 3 + rnd() * 2.2;
      const height = kind === "bush" ? scale * 0.9 : kind === "conifer" ? 9 + rnd() * 7 : 8 + rnd() * 6;
      const trunkH = kind === "bush" ? 0 : height * (kind === "conifer" ? 0.25 : 0.45);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      if (kind === "conifer") {
        m.compose(new THREE.Vector3(s.x, y + trunkH, s.z), q, new THREE.Vector3(scale * 0.8, (height - trunkH) / 1.6, scale * 0.8));
      } else {
        const sy = kind === "bush" ? scale * 0.7 : scale * 0.85;
        m.compose(new THREE.Vector3(s.x, y + trunkH + sy * 0.8, s.z), q, new THREE.Vector3(scale, sy, scale));
      }
      canopies.setMatrixAt(i, m);
      canopies.setColorAt(i, tint.setScalar(0.82 + rnd() * 0.32));
      if (trunkH > 0) {
        m.compose(new THREE.Vector3(s.x, y, s.z), q, new THREE.Vector3(1, trunkH + 0.5, 1));
        trunks.setMatrixAt(trunkCount++, m);
      }
      const r = scale * 1.25;
      const off = Math.min(height * 0.35, 6);
      m.compose(
        new THREE.Vector3(s.x + shadowOffset.x * off, y + 0.06, s.z + shadowOffset.y * off),
        new THREE.Quaternion(),
        new THREE.Vector3(r, 1, r * 0.85),
      );
      shadows.setMatrixAt(idx, m);
    });
    group.add(canopies);
  }
  trunks.count = trunkCount;
  group.add(trunks, shadows);
  return group;
}

function buildTeeMarkers(course: CourseData, terrain: TerrainModel): THREE.Group {
  const g = new THREE.Group();
  g.name = "tee-markers";
  // Small coloured blocks, so they never read as golf balls.
  const geo = new THREE.BoxGeometry(0.22, 0.16, 0.22);
  const mat = new THREE.MeshLambertMaterial({ color: 0xc8302b });
  for (const hole of course.holes) {
    const [ax, az] = [hole.tee.x, hole.tee.z];
    const next = hole.centerline[1] ?? [hole.pin.x, hole.pin.z];
    const L = Math.hypot(next[0] - ax, next[1] - az) || 1;
    const [dx, dz] = [(next[0] - ax) / L, (next[1] - az) / L];
    for (const side of [-1, 1]) {
      const x = ax - dz * side * 4 + dx * 2;
      const z = az + dx * side * 4 + dz * 2;
      const mk = new THREE.Mesh(geo, mat);
      mk.position.set(x, terrain.heightAt(x, z) + 0.08, z);
      g.add(mk);
    }
  }
  return g;
}

/** The complete stylized course: shaded ground, water, trees and tee markers. */
export function buildCourseLook(course: CourseData, terrain: TerrainModel, sunDir: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.name = "stylized-terrain";
  const masks = buildMasks(course);
  group.add(buildGroundMesh(course, terrain, masks));
  group.add(buildWater(course, terrain));
  group.add(buildTrees(course, terrain, sunDir));
  group.add(buildTeeMarkers(course, terrain));
  return group;
}
