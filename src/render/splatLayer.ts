import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

export type SplatSource = { url: string } | { fileBytes: ArrayBuffer; fileName: string };

/** Photoreal course visuals: a Gaussian splat placed into the hole frame. Physics never
 * reads from it; the heightfield is derived from the same reconstruction so they agree. */
export class SplatLayer {
  readonly group = new THREE.Group();
  private mesh: SplatMesh | null = null;

  constructor(private matrix: THREE.Matrix4) {
    this.group.name = "splat-layer";
  }

  get loaded(): boolean {
    return this.mesh !== null;
  }

  async load(source: SplatSource): Promise<number> {
    this.unload();
    const mesh = new SplatMesh(source);
    this.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    this.group.add(mesh);
    await mesh.initialized;
    this.mesh = mesh;
    return mesh.packedSplats?.numSplats ?? 0;
  }

  unload() {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }
}

/** Resolve a splat URL to something Spark can load. Hosts that only serve text get the
 * binary as base64 in a `<name>.<ext>.b64.txt` file; it is decoded here. */
export async function splatSourceFromUrl(url: string): Promise<SplatSource> {
  const m = url.match(/([^/]+)\.b64\.txt$/);
  if (!m) return { url };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = (await res.text()).replace(/\s+/g, "");
  const bin = atob(text);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { fileBytes: bytes.buffer, fileName: m[1] };
}

export function matrixFromRows(rows: number[][]): THREE.Matrix4 {
  return new THREE.Matrix4().set(...(rows.flat() as Parameters<THREE.Matrix4["set"]>));
}
