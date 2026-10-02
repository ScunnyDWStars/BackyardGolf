import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";

/** Renderer, lights and a broadcast-blue sky gradient. */
export function createScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = document.createElement("canvas");
  sky.width = 2;
  sky.height = 256;
  const g = sky.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#3d7cc9");
  grad.addColorStop(0.55, "#9cc4e8");
  grad.addColorStop(1, "#dfeaf2");
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const skyTex = new THREE.CanvasTexture(sky);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0xcfe0ec, 250, 900);

  scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a6b2a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff3dc, 2.2);
  sun.position.set(-120, 200, 80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -60;
  sc.right = 60;
  sc.top = 60;
  sc.bottom = -60;
  sc.far = 600;
  scene.add(sun, sun.target);

  // Spark composites Gaussian splats with ordinary meshes in the same scene.
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 3000);
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  return { renderer, scene, camera, sun, spark };
}
