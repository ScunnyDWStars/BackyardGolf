import * as THREE from "three";
import "./style.css";
import type { CourseData } from "./course/types";
import { HoleSession } from "./game/session";
import { v3 } from "./math/vec3";
import { CameraDirector } from "./render/cameraDirector";
import { createScene } from "./render/scene";
import { SplatLayer, type SplatSource, matrixFromRows, splatSourceFromUrl } from "./render/splatLayer";
import { AimMarker, buildBall, buildPin, buildPuttingGrid, buildStylizedTerrain } from "./render/stylizedTerrain";
import { AnalogSwing, defaultSwingConfig } from "./swing/analogSwing";
import { Hud } from "./ui/hud";

type ViewMode = "stylized" | "splat";

const params = new URLSearchParams(location.search);
const courseUrl = params.get("course") ?? "courses/romanby-h2.json";
// The trained splat is not in the repo (it is derived from third-party footage). Dev serves it
// from the local data/ dir; a private build bundles it by setting VITE_SPLAT_URL.
const defaultSplatUrl: string = import.meta.env.VITE_SPLAT_URL ?? "/data/romanby-h2-full/splat/splat.ply";

const toV = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
const touchScreen = window.matchMedia?.("(pointer: coarse)").matches ?? false;

async function main() {
  const app = document.getElementById("app")!;
  const course: CourseData = await (await fetch(courseUrl)).json();
  const { renderer, scene, camera, sun } = createScene(app);
  const hud = new Hud(app);

  // Light, seeded-by-param wind so tests can force calm conditions.
  const windMph = Number(params.get("wind") ?? 6);
  const windDir = Number(params.get("windDir") ?? 200) * (Math.PI / 180);
  const wind = v3(Math.sin(windDir) * windMph * 0.447, 0, -Math.cos(windDir) * windMph * 0.447);
  let session = new HoleSession(course, 0, wind);

  const terrainGroup = buildStylizedTerrain(course, session.terrain);
  scene.add(terrainGroup);
  const pin = buildPin(toV(session.hole.pin));
  scene.add(pin);
  const ball = buildBall();
  scene.add(ball);
  const aim = new AimMarker();
  scene.add(aim.group);
  const grid = buildPuttingGrid(session.terrain, toV(session.hole.pin));
  grid.visible = false;
  scene.add(grid);
  const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
  scene.add(trail);
  const trailPts: THREE.Vector3[] = [];

  const splat = new SplatLayer(matrixFromRows(course.splat?.matrix ?? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]));
  scene.add(splat.group);
  // The player's chosen look, remembered per browser. Storage may be unavailable
  // (private windows, embedded viewers), so every access is guarded.
  const VIEW_KEY = "backyardgolf.view";
  const readPreference = (): ViewMode => {
    try {
      return localStorage.getItem(VIEW_KEY) === "stylized" ? "stylized" : "splat";
    } catch {
      return "splat";
    }
  };
  let preferred: ViewMode = params.get("view") === "stylized" ? "stylized" : readPreference();
  let splatState: "loading" | "ready" | "none" = "none";
  let view: ViewMode = "stylized";
  const setView = (v: ViewMode) => {
    view = v === "splat" && !splat.loaded ? "stylized" : v;
    terrainGroup.visible = view === "stylized";
    splat.group.visible = view === "splat";
    scene.fog = view === "splat" ? null : new THREE.Fog(0xcfe0ec, 250, 900);
    director.splatFraming = view === "splat";
    hud.setViewState(view, splatState);
    if (session.phase === "address" && director.mode !== "flyover" && director.mode !== "overhead") frameAddress(true);
  };
  /** The player picked a look: remember it and switch (or switch once the splat arrives). */
  const chooseView = (v: ViewMode) => {
    preferred = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
    if (v === "splat" && splatState === "loading") hud.toast("Photoreal course is still loading — it will switch when ready");
    else if (v === "splat" && splatState === "none") hud.toast("No photoreal course for this hole yet");
    else hud.hideToast();
    setView(v);
  };
  const loadSplat = async (src: SplatSource, quiet = false) => {
    splatState = "loading";
    hud.setViewState(view, splatState);
    try {
      const n = await splat.load(src);
      splatState = "ready";
      if (!quiet) preferred = "splat";
      setView(preferred);
      if (preferred === "splat") hud.toast(`Photoreal course ready · ${(n / 1000).toFixed(0)}k splats`);
      else hud.hideToast();
      document.body.dataset.splat = "loaded";
    } catch (err) {
      splatState = splat.loaded ? "ready" : "none";
      hud.setViewState(view, splatState);
      if (quiet) hud.hideToast();
      else hud.toast(`Could not load splat: ${err}`);
    }
  };
  const splatParam = params.get("splat") ?? course.splat?.url;
  if (splatParam !== "none") {
    // Load in the background even when the player prefers the stylized look, so switching is
    // instant. If the file is missing the hole simply plays on the stylized terrain.
    splatState = "loading";
    if (preferred === "splat") hud.toast("Loading photoreal course…", 60000);
    splatSourceFromUrl(splatParam ?? defaultSplatUrl)
      .then((src) => loadSplat(src, true))
      .catch(() => {
        splatState = "none";
        hud.setViewState(view, splatState);
        hud.hideToast();
      });
  }
  hud.setViewState(view, splatState);
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".ply,.spz,.splat,.ksplat,.sog";
  picker.addEventListener("change", async () => {
    const f = picker.files?.[0];
    if (f) await loadSplat({ fileBytes: await f.arrayBuffer(), fileName: f.name });
  });

  const director = new CameraDirector(camera, session.terrain);
  const swing = new AnalogSwing(defaultSwingConfig(window.innerHeight));
  window.addEventListener("resize", () => swing.setConfig(defaultSwingConfig(window.innerHeight)));

  let restTimer = 0;
  const putting = () => session.club.isPutter === true;
  const frameAddress = (snap = false) => director.frameAddress(toV(session.ballPos), session.aimHeading, putting(), snap);

  const startHole = (flyover: boolean) => {
    session = new HoleSession(course, 0, wind);
    trailPts.length = 0;
    trail.geometry.setFromPoints([]);
    if (flyover && params.get("flyover") !== "0") {
      director.startFlyover(session.hole.centerline, toV(session.hole.pin));
      hud.setHelp("Hole flyover — click or press Space to skip");
    } else {
      frameAddress(true);
    }
  };
  director.onFlyoverDone = () => frameAddress(true);
  startHole(true);

  // --- input -------------------------------------------------------------------------
  const canSwing = () => session.phase === "address" && director.mode !== "flyover";
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (director.mode === "flyover") {
      director.mode = "address";
      frameAddress(true);
      return;
    }
    if (!canSwing()) return;
    renderer.domElement.setPointerCapture(e.pointerId);
    swing.begin({ t: e.timeStamp / 1000, x: e.clientX, y: e.clientY });
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (swing.phase === "backswing" || swing.phase === "downswing") {
      swing.move({ t: e.timeStamp / 1000, x: e.clientX, y: e.clientY });
      if (swing.isDone()) takeShot();
    }
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    swing.end({ t: e.timeStamp / 1000, x: e.clientX, y: e.clientY });
    if (swing.isDone()) takeShot();
    hud.setMeter(null);
  });

  function takeShot() {
    const result = swing.result!;
    swing.phase = "idle";
    hud.setMeter(null);
    session.hit(result);
    trailPts.length = 0;
    director.follow();
  }

  // Actions shared by the keyboard and the on-screen buttons.
  const canAdjust = () => session.phase === "address" && director.mode !== "flyover";
  const aimHeld = { left: false, right: false, fast: false };
  const actions = {
    skip() {
      if (director.mode === "flyover") {
        director.mode = "address";
        frameAddress(true);
      } else if (session.phase === "flight") {
        session.finishShot();
      }
    },
    club(delta: number) {
      if (!canAdjust()) return;
      session.selectClub(delta);
      frameAddress();
    },
    overhead() {
      if (!canAdjust()) return;
      if (director.mode === "overhead") frameAddress();
      else director.overhead(toV(session.aimPoint()));
    },
    toggleView() {
      chooseView(view === "splat" ? "stylized" : "splat");
    },
    setView(v: ViewMode) {
      chooseView(v);
    },
    loadSplat() {
      picker.click();
    },
    restart() {
      startHole(false);
    },
    aim(dir: -1 | 0 | 1) {
      aimHeld.left = dir < 0;
      aimHeld.right = dir > 0;
    },
  };
  hud.bindControls(actions);

  window.addEventListener("keydown", (e) => {
    aimHeld.fast = e.shiftKey;
    if (e.key === "ArrowLeft" || e.key === "a") aimHeld.left = true;
    if (e.key === "ArrowRight" || e.key === "d") aimHeld.right = true;
    if (e.key === " ") actions.skip();
    if (e.key === "ArrowUp" || e.key === "w") actions.club(-1);
    if (e.key === "ArrowDown" || e.key === "s") actions.club(1);
    if (e.key === "o") actions.overhead();
    if (e.key === "v") actions.toggleView();
    if (e.key === "l") actions.loadSplat();
    if (e.key === "r") actions.restart();
  });
  window.addEventListener("keyup", (e) => {
    aimHeld.fast = e.shiftKey;
    if (e.key === "ArrowLeft" || e.key === "a") aimHeld.left = false;
    if (e.key === "ArrowRight" || e.key === "d") aimHeld.right = false;
  });

  // --- loop --------------------------------------------------------------------------
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);

    if (canAdjust() && (aimHeld.left || aimHeld.right)) {
      const turn = (aimHeld.fast ? 1.2 : 0.35) * dt;
      session.aimHeading += aimHeld.left ? -turn : turn;
      if (director.mode !== "overhead") frameAddress();
    }

    const cameToRest = session.update(dt);
    const ballPos = toV(session.ball?.pos ?? session.ballPos);
    ball.position.copy(ballPos).add(new THREE.Vector3(0, 0.04, 0));
    if (session.phase === "flight") {
      trailPts.push(ballPos.clone());
      if (trailPts.length % 2 === 0) trail.geometry.setFromPoints(trailPts);
    }
    if (cameToRest) {
      const r = session.lastResult!;
      if (session.phase === "holed") {
        hud.toast(`${hud.scoreName(session.strokes, session.hole.par)}! ${session.strokes} strokes — press R or ↺ to replay`, 8000);
        document.body.dataset.holed = "true";
      } else {
        hud.toast(hud.shotSummary(r));
      }
      restTimer = 1.4;
    }
    if (restTimer > 0) {
      restTimer -= dt;
      if (restTimer <= 0 && session.phase === "address") frameAddress();
    }

    const showAim = session.phase === "address" && director.mode !== "flyover" && swing.phase !== "downswing";
    aim.group.visible = showAim;
    if (showAim) {
      const power = swing.phase === "backswing" ? Math.max(0.05, swing.currentPower) : 1;
      const to = toV(session.aimPoint(power));
      const apex = putting() ? 0 : Math.min(30, ballPos.distanceTo(to) * 0.12);
      aim.update(ballPos, to, apex, putting() ? 0.25 : 1 + ballPos.distanceTo(to) / 150);
    }
    grid.visible = session.lie === "green" && session.phase !== "holed";
    if (swing.phase === "backswing" || swing.phase === "downswing") hud.setMeter(swing.currentPower);

    if (director.mode !== "flyover") {
      hud.setHelp(
        session.phase === "flight"
          ? "Space: skip"
          : touchScreen
            ? "Swing: drag down, then push up"
            : "Swing: drag down, then push up · ←/→ aim · ↑/↓ club · O overhead · V photoreal/stylized · L load splat · R restart",
      );
    }
    director.update(dt, ballPos, toV(session.ball?.vel ?? v3()));
    sun.position.copy(ballPos).add(new THREE.Vector3(-120, 200, 80));
    sun.target.position.copy(ballPos);
    hud.update(session, course.name);
    renderer.render(scene, camera);
  });

  // Hooks for automated play-testing.
  (window as unknown as { __game: unknown }).__game = {
    get session() {
      return session;
    },
    get view() {
      return view;
    },
    director,
  };
  document.body.dataset.ready = "true";
}

main().catch((err) => {
  document.body.textContent = `Failed to start: ${err}`;
  console.error(err);
});
