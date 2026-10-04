import * as THREE from "three";
import "./style.css";
import type { CourseData } from "./course/types";
import { Round } from "./game/round";
import { v3 } from "./math/vec3";
import { CameraDirector } from "./render/cameraDirector";
import { createScene } from "./render/scene";
import { SplatLayer, type SplatSource, matrixFromRows, splatSourceFromUrl } from "./render/splatLayer";
import { AimMarker, buildBall, buildPin, buildPuttingGrid, buildStylizedTerrain } from "./render/stylizedTerrain";
import { AnalogSwing, type SwingResult, defaultSwingConfig } from "./swing/analogSwing";
import { OVERRUN, PITCH_METER, PUTT_METER, ThreeClickMeter } from "./swing/threeClick";
import { Hud } from "./ui/hud";

type ViewMode = "stylized" | "splat";

const params = new URLSearchParams(location.search);
interface CatalogEntry {
  id: string;
  file: string;
  name: string;
  place: string;
  country: string;
  holes: number;
  par: number;
  yards: number;
  photorealHoles: number[];
}
const COURSE_KEY = "backyardgolf.course";
// The trained splat is not in the repo (it is derived from third-party footage). Dev serves it
// from the local data/ dir; a private build bundles it by setting VITE_SPLAT_URL.
const defaultSplatUrl: string = import.meta.env.VITE_SPLAT_URL ?? "/data/romanby-h2-full/splat/splat.ply";

const toV = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
const touchScreen = window.matchMedia?.("(pointer: coarse)").matches ?? false;

async function main() {
  const app = document.getElementById("app")!;
  // The course list is optional: without it the game still opens the default course.
  let catalog: CatalogEntry[] = [];
  try {
    catalog = (await (await fetch("courses/index.json")).json()).courses ?? [];
  } catch {
    catalog = [];
  }
  let storedId: string | null = null;
  try {
    storedId = localStorage.getItem(COURSE_KEY);
  } catch {
    storedId = null;
  }
  const picked = catalog.find((c) => c.id === storedId) ?? catalog.find((c) => c.id === "romanby") ?? catalog[0];
  const courseUrl = params.get("course") ?? picked?.file ?? "courses/romanby.json";
  const currentCourseId = params.get("course") ? null : (picked?.id ?? null);
  const course: CourseData = await (await fetch(courseUrl)).json();
  const { renderer, scene, camera, sun, spark } = createScene(app);
  const hud = new Hud(app);
  hud.setCredits(course.attribution);

  // Light, seeded-by-param wind so tests can force calm conditions.
  const windMph = Number(params.get("wind") ?? 6);
  const windDir = Number(params.get("windDir") ?? 200) * (Math.PI / 180);
  const wind = v3(Math.sin(windDir) * windMph * 0.447, 0, -Math.cos(windDir) * windMph * 0.447);
  // ?hole=<number> starts on a given hole (useful for testing and sharing a hole).
  const startIndex = Math.max(0, course.holes.findIndex((h) => h.number === Number(params.get("hole"))));
  const round = new Round(course, wind, startIndex);
  let session = round.session;

  const terrainGroup = buildStylizedTerrain(course, session.terrain);
  scene.add(terrainGroup);
  const pin = buildPin(toV(session.hole.pin));
  scene.add(pin);
  const ball = buildBall();
  scene.add(ball);
  const aim = new AimMarker();
  scene.add(aim.group);
  let grid = buildPuttingGrid(session.terrain, toV(session.hole.pin));
  grid.visible = false;
  scene.add(grid);
  /** Move the flag and rebuild the putting grid for the current hole. */
  const placeHoleProps = () => {
    pin.position.copy(toV(session.hole.pin));
    scene.remove(grid);
    grid.geometry.dispose();
    grid = buildPuttingGrid(session.terrain, toV(session.hole.pin));
    grid.visible = false;
    scene.add(grid);
  };
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
  // A splat usually covers only the hole(s) that were filmed.
  const splatCovers = () => !course.splat?.holes || course.splat.holes.includes(session.hole.number);
  const viewState = () => (splatCovers() ? splatState : "none");
  const setView = (v: ViewMode) => {
    view = v === "splat" && (!splat.loaded || !splatCovers()) ? "stylized" : v;
    terrainGroup.visible = view === "stylized";
    splat.group.visible = view === "splat";
    // Spark keeps its last splat draw while the camera is still; make it redraw now.
    spark.setDirty();
    scene.fog = view === "splat" ? null : new THREE.Fog(0xcfe0ec, 250, 900);
    director.splatFraming = view === "splat";
    hud.setViewState(view, viewState());
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
    if (v === "splat" && viewState() === "loading") hud.toast("Photoreal course is still loading — it will switch when ready");
    else if (v === "splat" && viewState() === "none") hud.toast("No photoreal course for this hole yet");
    else hud.hideToast();
    setView(v);
  };
  const loadSplat = async (src: SplatSource, quiet = false) => {
    splatState = "loading";
    hud.setViewState(view, viewState());
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
      hud.setViewState(view, viewState());
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
        hud.setViewState(view, viewState());
        hud.hideToast();
      });
  }
  hud.setViewState(view, viewState());
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

  // 3-click meter: putts and shots inside 100 yds, or every shot if the player chooses.
  const meter = new ThreeClickMeter(PITCH_METER);
  const TC_KEY = "backyardgolf.threeClickAll";
  let tcAll = false;
  try {
    tcAll = localStorage.getItem(TC_KEY) === "1";
  } catch {
    // Storage unavailable: default applies.
  }
  hud.bindThreeClickSetting(tcAll, (all) => {
    tcAll = all;
    try {
      localStorage.setItem(TC_KEY, all ? "1" : "0");
    } catch {
      // Not persisted; applies for this visit.
    }
  });

  let restTimer = 0;
  const putting = () => session.club.isPutter === true;
  const frameAddress = (snap = false) => director.frameAddress(toV(session.ballPos), session.aimHeading, putting(), snap);

  let cardTimer = 0;
  let handledShots = 0;
  const startHole = (index: number, flyover: boolean) => {
    session = round.play(index);
    handledShots = 0;
    placeHoleProps();
    trailPts.length = 0;
    trail.geometry.setFromPoints([]);
    cardTimer = 0;
    hud.hideScorecard();
    hud.hideToast();
    delete document.body.dataset.holed;
    setView(preferred);
    if (flyover && params.get("flyover") !== "0") {
      director.startFlyover(session.hole.centerline, toV(session.hole.pin));
      hud.setHelp("Hole flyover — click or press Space to skip");
    } else {
      frameAddress(true);
    }
  };
  director.onFlyoverDone = () => frameAddress(true);
  startHole(startIndex, true);

  /** Scorecard data for the HUD. */
  const showCard = (afterHole: boolean) => {
    const totals = round.totals();
    const next = round.nextIndex();
    const acts: { label: string; primary?: boolean; run: () => void }[] = [];
    if (afterHole && next !== null) acts.push({ label: `Next: hole ${course.holes[next].number} ▶`, primary: true, run: () => startHole(next, true) });
    if (afterHole && next === null) acts.push({ label: "New round", primary: true, run: () => { round.scores.fill(null); startHole(0, true); } });
    if (!afterHole) acts.push({ label: "Close", primary: true, run: () => hud.hideScorecard() });
    acts.push({ label: `Replay hole ${session.hole.number}`, run: () => startHole(round.holeIndex, false) });
    hud.showScorecard(
      {
        course: course.name,
        holes: course.holes.map((h, i) => ({ number: h.number, par: h.par, yards: h.lengthYards, score: round.scores[i] })),
        current: round.holeIndex,
        toPar: totals.toPar,
        played: totals.played,
      },
      acts,
      (i) => startHole(i, true),
    );
  };

  // --- input -------------------------------------------------------------------------
  const canSwing = () => session.phase === "address" && director.mode !== "flyover";
  const threeClickMode = () => canSwing() && session.usesThreeClick(tcAll);
  const meterClick = () => {
    if (meter.phase === "idle" || meter.phase === "done") meter.config = putting() ? PUTT_METER : PITCH_METER;
    meter.click();
    if (meter.phase === "done") takeShot(meter.result!);
  };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (director.mode === "flyover") {
      director.mode = "address";
      frameAddress(true);
      return;
    }
    if (!canSwing()) return;
    if (threeClickMode()) {
      meterClick();
      return;
    }
    renderer.domElement.setPointerCapture(e.pointerId);
    swing.begin({ t: e.timeStamp / 1000, x: e.clientX, y: e.clientY });
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (swing.phase === "backswing" || swing.phase === "downswing") {
      swing.move({ t: e.timeStamp / 1000, x: e.clientX, y: e.clientY });
      if (swing.isDone()) takeShot(swing.result!);
    }
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    swing.end({ t: e.timeStamp / 1000, x: e.clientX, y: e.clientY });
    if (swing.isDone()) takeShot(swing.result!);
    hud.setMeter(null);
  });

  function takeShot(result: SwingResult) {
    swing.phase = "idle";
    meter.reset();
    hud.setMeter(null);
    hud.setThreeClick(null);
    session.hit(result);
    trailPts.length = 0;
    director.follow();
  }

  // Actions shared by the keyboard and the on-screen buttons.
  const canAdjust = () => session.phase === "address" && director.mode !== "flyover" && !meter.active;
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
      startHole(round.holeIndex, false);
    },
    scorecard() {
      if (hud.scorecardOpen) hud.hideScorecard();
      else showCard(session.phase === "holed");
    },
    courses() {
      if (hud.coursesOpen) {
        hud.hideCourses();
        return;
      }
      hud.showCourses(catalog, currentCourseId, (id) => {
        if (id === currentCourseId) {
          hud.hideCourses();
          return;
        }
        try {
          localStorage.setItem(COURSE_KEY, id);
        } catch {
          // Without storage the choice can't survive a reload; load it directly instead.
        }
        location.reload();
      });
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
    if (e.key === " ") {
      e.preventDefault();
      if (threeClickMode()) meterClick();
      else actions.skip();
    }
    if (e.key === "ArrowUp" || e.key === "w") actions.club(-1);
    if (e.key === "ArrowDown" || e.key === "s") actions.club(1);
    if (e.key === "o") actions.overhead();
    if (e.key === "v") actions.toggleView();
    if (e.key === "l") actions.loadSplat();
    if (e.key === "r") actions.restart();
    if (e.key === "c") actions.scorecard();
    if (e.key === "Escape") {
      hud.hideScorecard();
      hud.hideCourses();
    }
  });
  window.addEventListener("keyup", (e) => {
    aimHeld.fast = e.shiftKey;
    if (e.key === "ArrowLeft" || e.key === "a") aimHeld.left = false;
    if (e.key === "ArrowRight" || e.key === "d") aimHeld.right = false;
  });

  // --- 3-click meter display --------------------------------------------------------
  let aimStill = 1;
  let meterInfo: { key: string; target: number; ticks: { power: number; label: string }[] } | null = null;
  const FT = 3.28084;
  const YD = 1.09361;
  /** Target mark and distance ticks; the solver runs only once aim has settled. */
  const updateMeterInfo = () => {
    const key = `${session.club.id}|${session.ballPos.x},${session.ballPos.z}|${session.aimHeading.toFixed(4)}|${session.lie}`;
    if (meterInfo?.key === key || (meterInfo && aimStill < 0.15)) return;
    const unit = putting() ? FT : YD;
    const max = session.distanceAtPower(1) * unit;
    const step = putting() ? (max > 60 ? 20 : max > 25 ? 10 : 5) : max > 120 ? 20 : 10;
    const ticks: { power: number; label: string }[] = [];
    for (let d = step; d < max; d += step) {
      // Invert the power→distance scale for each tick.
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) / 2;
        if (session.distanceAtPower(mid) * unit < d) lo = mid;
        else hi = mid;
      }
      ticks.push({ power: (lo + hi) / 2, label: String(d) });
    }
    meterInfo = { key, target: session.idealPower(), ticks };
  };
  const unitLabel = (m: number) => (putting() ? `${Math.round(m * FT)} ft` : `${Math.round(m * YD)} yds`);

  // --- loop --------------------------------------------------------------------------
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    // Physics and animation use a capped step; interface timers use real time so slow
    // devices don't make the scorecard or camera wait longer.
    const realDt = timer.getDelta();
    const dt = Math.min(realDt, 0.1);

    if (canAdjust() && (aimHeld.left || aimHeld.right)) {
      const turn = (aimHeld.fast ? 1.2 : 0.35) * dt;
      session.aimHeading += aimHeld.left ? -turn : turn;
      aimStill = 0;
      if (director.mode !== "overhead") frameAddress();
    } else {
      aimStill += dt;
    }
    if (meter.active) {
      meter.update(dt);
      if (meter.phase === "done") takeShot(meter.result!);
    }

    // A shot can also finish outside the loop (Skip), so count finished shots.
    session.update(dt);
    const cameToRest = session.shots.length > handledShots;
    handledShots = session.shots.length;
    const ballPos = toV(session.ball?.pos ?? session.ballPos);
    ball.position.copy(ballPos).add(new THREE.Vector3(0, 0.04, 0));
    if (session.phase === "flight") {
      trailPts.push(ballPos.clone());
      if (trailPts.length % 2 === 0) trail.geometry.setFromPoints(trailPts);
    }
    if (cameToRest) {
      const r = session.lastResult!;
      if (session.phase === "holed") {
        round.record();
        hud.toast(`${hud.scoreName(session.strokes, session.hole.par)}! ${session.strokes} strokes`, 2600);
        document.body.dataset.holed = "true";
        cardTimer = 2.4;
      } else {
        hud.toast(hud.shotSummary(r));
      }
      restTimer = 1.4;
    }
    if (cardTimer > 0) {
      cardTimer -= realDt;
      if (cardTimer <= 0 && session.phase === "holed") showCard(true);
    }
    if (restTimer > 0) {
      restTimer -= realDt;
      if (restTimer <= 0 && session.phase === "address") frameAddress();
    }

    const tcMode = threeClickMode();
    if (tcMode) {
      updateMeterInfo();
      const info = meterInfo!;
      const live = meter.active || meter.phase === "done";
      const shown = live ? (meter.phase === "returning" ? meter.power : Math.max(0, meter.marker)) : info.target;
      hud.setThreeClick({
        marker: meter.marker,
        locked: meter.phase === "returning" ? meter.power : null,
        target: info.target,
        zone: meter.config.zone,
        overrun: OVERRUN,
        ticks: info.ticks,
        readout: live ? unitLabel(session.distanceAtPower(shown)) : `To hole ${unitLabel(session.distanceToPin)}`,
      });
    } else {
      hud.setThreeClick(null);
    }

    const showAim = session.phase === "address" && director.mode !== "flyover" && swing.phase !== "downswing";
    aim.group.visible = showAim;
    if (showAim) {
      let to: THREE.Vector3;
      if (tcMode && meterInfo) {
        // Ring where the ball would stop at the meter's power (the target mark until you start).
        const p = meter.active ? (meter.phase === "returning" ? meter.power : Math.max(0.02, meter.marker)) : meterInfo.target;
        to = toV(session.pointAlongAim(session.distanceAtPower(p)));
      } else {
        const power = swing.phase === "backswing" ? Math.max(0.05, swing.currentPower) : 1;
        to = toV(session.aimPoint(power));
      }
      const apex = putting() ? 0 : Math.min(30, ballPos.distanceTo(to) * 0.12);
      aim.update(ballPos, to, apex, putting() ? 0.25 : 1 + ballPos.distanceTo(to) / 150);
    }
    grid.visible = session.lie === "green" && session.phase !== "holed";
    if (swing.phase === "backswing" || swing.phase === "downswing") hud.setMeter(swing.currentPower);

    if (director.mode !== "flyover") {
      const keys = " · ←/→ aim · ↑/↓ club · O overhead · V photoreal/stylized · C scorecard · R restart";
      hud.setHelp(
        session.phase === "flight"
          ? "Space: skip"
          : tcMode
            ? touchScreen
              ? "Tap to start · tap at ⚑ for power · tap in the green zone"
              : "Click or Space: start · again at ⚑ for power · again in the green zone" + keys
            : touchScreen
              ? "Swing: drag down, then push up"
              : "Swing: drag down, then push up" + keys,
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
    round,
    startHole,
    meter,
    get meterTarget() {
      return meterInfo?.target ?? null;
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
