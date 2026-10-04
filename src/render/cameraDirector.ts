import * as THREE from "three";
import type { TerrainModel } from "../course/terrain";

export type CameraMode = "flyover" | "address" | "putt" | "flight" | "overhead";

/** Broadcast-style camera work: hole flyover, behind-the-ball address, chase cam in flight. */
export class CameraDirector {
  mode: CameraMode = "address";
  private flyT = 0;
  private flyCurve: THREE.CatmullRomCurve3 | null = null;
  private readonly lookAt = new THREE.Vector3();
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  onFlyoverDone: (() => void) | null = null;
  /** Splats only look right near the capture path (a drone ~2.5 m up), so the photoreal
   * view frames shots from higher and further back than the stylized one. */
  splatFraming = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly terrain: TerrainModel,
  ) {}

  startFlyover(centerline: [number, number][], pin: THREE.Vector3) {
    const pts = centerline.map(([x, z]) => new THREE.Vector3(x, this.terrain.heightAt(x, z) + 28, z));
    pts.push(pin.clone().add(new THREE.Vector3(0, 12, 0)));
    this.flyCurve = new THREE.CatmullRomCurve3(pts);
    this.flyT = 0;
    this.mode = "flyover";
  }

  private ground(x: number, z: number) {
    return this.terrain.heightAt(x, z);
  }

  /** Snap the camera behind the ball looking along the aim line. */
  frameAddress(ball: THREE.Vector3, heading: number, putting: boolean, snap = false) {
    this.mode = putting ? "putt" : "address";
    const back = putting ? (this.splatFraming ? 5 : 2.6) : this.splatFraming ? 6.5 : 4.2;
    const up = putting ? (this.splatFraming ? 2.6 : 1.1) : this.splatFraming ? 2.8 : 1.7;
    const dir = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
    this.desiredPos.copy(ball).addScaledVector(dir, -back);
    this.desiredPos.y = Math.max(this.desiredPos.y, this.ground(this.desiredPos.x, this.desiredPos.z)) + up;
    // Look at the ground a little way ahead, so the ball sits in the lower third of the
    // frame with the horizon above centre (clear of the meter at the bottom of the screen).
    this.desiredLook.copy(ball).addScaledVector(dir, putting ? 6 : 15);
    this.desiredLook.y = this.ground(this.desiredLook.x, this.desiredLook.z);
    if (snap) {
      this.camera.position.copy(this.desiredPos);
      this.lookAt.copy(this.desiredLook);
    }
  }

  follow() {
    this.mode = "flight";
  }

  overhead(center: THREE.Vector3) {
    this.mode = "overhead";
    this.desiredPos.set(center.x + 1, center.y + 140, center.z + 60);
    this.desiredLook.copy(center);
  }

  update(dt: number, ball: THREE.Vector3, ballVel: THREE.Vector3) {
    if (this.mode === "flyover" && this.flyCurve) {
      this.flyT += dt / 9;
      const t = Math.min(1, this.flyT);
      const eased = t * t * (3 - 2 * t);
      this.camera.position.copy(this.flyCurve.getPointAt(eased));
      this.lookAt.copy(this.flyCurve.getPointAt(Math.min(1, eased + 0.12)));
      this.lookAt.y -= 22;
      this.camera.lookAt(this.lookAt);
      if (t >= 1) {
        this.mode = "address";
        this.onFlyoverDone?.();
      }
      return;
    }
    if (this.mode === "flight") {
      const horiz = new THREE.Vector3(ballVel.x, 0, ballVel.z);
      if (horiz.lengthSq() > 0.01) horiz.normalize();
      else horiz.subVectors(ball, this.camera.position).setY(0).normalize();
      this.desiredPos.copy(ball).addScaledVector(horiz, -14);
      this.desiredPos.y = Math.max(ball.y + 4, this.ground(this.desiredPos.x, this.desiredPos.z) + 2);
      this.desiredLook.copy(ball);
    }
    const k = 1 - Math.exp(-dt * (this.mode === "flight" ? 3 : 4));
    this.camera.position.lerp(this.desiredPos, k);
    this.lookAt.lerp(this.desiredLook, k);
    this.camera.lookAt(this.lookAt);
  }
}
