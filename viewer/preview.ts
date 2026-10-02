// Standalone viewer for a trained splat in its aligned "hole frame" (metres, +Y up,
// -Z from tee to green). Query params:
//   ?splat=<url>&align=<url>&view=tee|mid|green|top
// Defaults point at the local, git-ignored Romanby hole 2 reconstruction.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

interface Alignment {
  matrix_row_major: number[][];
  camera_track_hole_frame: [number, number, number][];
}

const params = new URLSearchParams(location.search);
const splatUrl = params.get("splat") ?? "/data/romanby-h2/splat/splat.ply";
const alignUrl = params.get("align") ?? "/data/romanby-h2/align.json";
const status = document.getElementById("status")!;

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9d4de);
scene.add(new SparkRenderer({ renderer }));

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

let track: THREE.Vector3[] = [];
let splat: SplatMesh | null = null;
let alignMatrix = new THREE.Matrix4();

function applyAlignment(mesh: SplatMesh) {
  alignMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
}

async function loadSplat(source: { url: string } | { fileBytes: ArrayBuffer; fileName: string }) {
  if (splat) {
    scene.remove(splat);
    splat.dispose();
  }
  status.textContent = "loading splat…";
  const mesh = new SplatMesh(source);
  applyAlignment(mesh);
  scene.add(mesh);
  await mesh.initialized;
  splat = mesh;
  status.textContent = `${mesh.packedSplats?.numSplats?.toLocaleString() ?? "?"} splats loaded`;
  document.body.dataset.loaded = "true";
}

function setView(name: string) {
  if (track.length < 2) return;
  const at = (f: number) => track[Math.min(track.length - 1, Math.round(f * (track.length - 1)))];
  const ahead = (f: number, d: number) => {
    const i = Math.min(track.length - 1, Math.round(f * (track.length - 1)));
    const j = Math.min(track.length - 1, i + d);
    return track[j].clone();
  };
  const lift = new THREE.Vector3(0, 6, 0);
  switch (name) {
    case "mid":
      camera.position.copy(at(0.45)).add(lift);
      controls.target.copy(ahead(0.45, 8)).setY(0);
      break;
    case "green":
      camera.position.copy(at(0.8)).add(lift);
      controls.target.copy(at(1)).setY(0);
      break;
    case "top": {
      const mid = at(0.5);
      camera.position.set(mid.x + 120, 260, mid.z + 40);
      controls.target.set(mid.x, 0, mid.z);
      break;
    }
    default:
      camera.position.copy(at(0)).add(new THREE.Vector3(0, 4, 0));
      controls.target.copy(ahead(0, 10)).setY(0);
  }
  controls.update();
}

async function main() {
  try {
    const align: Alignment = await (await fetch(alignUrl)).json();
    const m = align.matrix_row_major;
    alignMatrix = new THREE.Matrix4().set(...(m.flat() as Parameters<THREE.Matrix4["set"]>));
    track = align.camera_track_hole_frame.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  } catch {
    status.textContent = "no alignment file — showing raw COLMAP frame";
    track = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -10)];
  }
  setView(params.get("view") ?? "tee");
  await loadSplat({ url: splatUrl });
}

document.getElementById("file")!.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await loadSplat({ fileBytes: await file.arrayBuffer(), fileName: file.name });
});

window.addEventListener("keydown", (e) => {
  const views: Record<string, string> = { "1": "tee", "2": "mid", "3": "green", "4": "top" };
  if (views[e.key]) setView(views[e.key]);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

main().catch((err) => {
  status.textContent = `error: ${err}`;
  console.error(err);
});
