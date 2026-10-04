import type { HoleSession, ShotRecord } from "../game/session";
import type { Vec3 } from "../math/vec3";

const YARDS = 1.09361;
export const yd = (m: number) => Math.round(m * YARDS);

const LIE_NAMES: Record<string, string> = {
  tee: "Tee", fairway: "Fairway", rough: "Rough", green: "Green", bunker: "Bunker",
  water: "Water", "out-of-bounds": "Out of bounds",
};

const SCORE_NAMES: Record<number, string> = {
  [-3]: "Albatross", [-2]: "Eagle", [-1]: "Birdie", 0: "Par", 1: "Bogey", 2: "Double Bogey", 3: "Triple Bogey",
};

/** DOM overlay in the style of a TV golf broadcast. */
export class Hud {
  readonly root: HTMLElement;
  private els: Record<string, HTMLElement> = {};

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="panel hole-card">
        <div class="hole-no"><span data-k="hole"></span></div>
        <div class="hole-meta"><span data-k="course"></span><span data-k="par"></span></div>
        <div class="stroke">Stroke <b data-k="stroke"></b></div>
      </div>
      <div class="panel wind"><div class="arrow" data-k="windArrow">➤</div><div data-k="wind"></div></div>
      <div class="panel shot-info">
        <div class="club" data-k="club"></div>
        <div class="carry" data-k="carry"></div>
        <div class="lie" data-k="lie"></div>
      </div>
      <div class="panel to-pin"><div class="label">To pin</div><div class="big" data-k="toPin"></div></div>
      <div class="meter"><div class="fill" data-k="meterFill"></div><div class="full-line"></div></div>
      <div class="tc-meter" data-k="tc" hidden>
        <div class="tc-readout" data-k="tcReadout"></div>
        <div class="tc-track" data-k="tcTrack">
          <div class="tc-zone" data-k="tcZone"></div>
          <div class="tc-fill" data-k="tcFill"></div>
          <div class="tc-ticks" data-k="tcTicks"></div>
          <div class="tc-target" data-k="tcTarget" aria-hidden="true"><span>⚑</span></div>
          <div class="tc-marker" data-k="tcMarker"></div>
        </div>
      </div>
      <div class="toast" data-k="toast"></div>
      <div class="scorecard courses" data-k="courses" role="dialog" aria-label="Courses" hidden>
        <div class="card">
          <div class="card-head"><strong>Courses</strong><span>Mapped from OpenStreetMap</span></div>
          <div class="course-list" data-k="courseList"></div>
          <div class="card-actions"><button type="button" class="primary" data-k="coursesClose">Close</button></div>
        </div>
      </div>
      <div class="credits"><span class="full" data-k="credits"></span><span class="short" data-k="creditsShort"></span></div>
      <div class="help" data-k="help"></div>
      <div class="view-switch" role="group" aria-label="Course look">
        <button type="button" data-view="splat" aria-pressed="false">Photoreal</button>
        <button type="button" data-view="stylized" aria-pressed="true">Stylized</button>
      </div>
      <div class="controls" role="toolbar" aria-label="Shot controls">
        <button type="button" data-hold="-1" aria-label="Aim left">◀</button>
        <button type="button" data-act="clubUp" aria-label="Longer club">▲</button>
        <button type="button" data-hold="1" aria-label="Aim right">▶</button>
        <button type="button" data-act="overhead" aria-label="Overhead view">⌖</button>
        <button type="button" data-act="clubDown" aria-label="Shorter club">▼</button>
        <button type="button" data-act="skip" aria-label="Skip flyover or ball flight">⏭</button>
        <button type="button" data-act="restart" aria-label="Restart hole">↺</button>
        <button type="button" data-act="scorecard" aria-label="Scorecard">▤</button>
      </div>
      <div class="scorecard" data-k="scorecard" role="dialog" aria-label="Scorecard" hidden>
        <div class="card">
          <div class="card-head"><strong data-k="cardCourse"></strong><span data-k="cardTotal"></span><button type="button" class="card-courses" data-act="courses">Change course</button></div>
          <div class="card-table"><table data-k="cardTable"></table></div>
          <p class="card-hint">Tap a hole number to play it.</p>
          <label class="card-setting"><input type="checkbox" id="tc-all" data-k="tcAll" /> Use the 3-click meter for every shot (otherwise putts and shots inside 100 yds)</label>
          <div class="card-actions" data-k="cardActions"></div>
        </div>
      </div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => (this.els[el.dataset.k!] = el));
  }

  private set(k: string, text: string) {
    if (this.els[k].textContent !== text) this.els[k].textContent = text;
  }

  update(s: HoleSession, courseName: string) {
    this.set("hole", String(s.hole.number));
    this.set("course", courseName);
    this.set("par", `Par ${s.hole.par} · ${s.hole.lengthYards} yds${s.hole.name ? ` · ${s.hole.name}` : ""}`);
    this.set("stroke", String(Math.max(1, s.strokes + (s.phase === "holed" ? 0 : 1))));
    this.set("club", s.club.name);
    const carry = s.club.isPutter ? `Range ${yd(s.puttRange)} yds` : `Carry ${yd(s.carries.get(s.club.id) ?? 0)} yds`;
    this.set("carry", carry);
    this.set("lie", `Lie: ${LIE_NAMES[s.lie] ?? s.lie}`);
    const d = s.distanceToPin;
    this.set("toPin", s.lie === "green" && d < 30 ? `${(d * 3.28084).toFixed(0)} ft` : `${yd(d)} yds`);
    this.updateWind(s.wind, s.aimHeading);
  }

  private updateWind(w: Vec3, aimHeading: number) {
    const speed = Math.hypot(w.x, w.z);
    this.set("wind", speed < 0.3 ? "Calm" : `${(speed * 2.237).toFixed(0)} mph`);
    // Arrow shows where the wind blows relative to the player's aim (up = downwind).
    const windHeading = Math.atan2(w.x, -w.z);
    this.els.windArrow.style.transform = `rotate(${((windHeading - aimHeading) * 180) / Math.PI - 90}deg)`;
  }

  setMeter(power: number | null) {
    const fill = this.els.meterFill;
    if (power === null) {
      this.els.meterFill.parentElement!.classList.remove("active");
      return;
    }
    this.els.meterFill.parentElement!.classList.add("active");
    fill.style.height = `${Math.min(110, power * 100) / 1.1}%`;
    fill.classList.toggle("over", power > 1.0);
  }

  /** Wire the on-screen buttons. Aim buttons act while held, like the arrow keys. */
  bindControls(a: {
    aim(dir: -1 | 0 | 1): void;
    club(delta: number): void;
    overhead(): void;
    setView(view: "splat" | "stylized"): void;
    skip(): void;
    restart(): void;
    scorecard(): void;
    courses(): void;
  }) {
    const taps: Record<string, () => void> = {
      clubUp: () => a.club(-1),
      clubDown: () => a.club(1),
      overhead: a.overhead,
      skip: a.skip,
      restart: a.restart,
      scorecard: a.scorecard,
      courses: a.courses,
    };
    this.els.coursesClose.addEventListener("click", () => this.hideCourses());
    this.root.querySelectorAll<HTMLButtonElement>(".card-courses").forEach((b) => b.addEventListener("click", () => a.courses()));
    this.root.querySelectorAll<HTMLButtonElement>(".view-switch button").forEach((b) => {
      b.addEventListener("click", () => a.setView(b.dataset.view as "splat" | "stylized"));
    });
    this.root.querySelectorAll<HTMLButtonElement>(".controls button").forEach((b) => {
      const hold = b.dataset.hold;
      if (hold) {
        const dir = Number(hold) as -1 | 1;
        b.addEventListener("pointerdown", (e) => {
          b.setPointerCapture(e.pointerId);
          a.aim(dir);
        });
        for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(ev, () => a.aim(0));
      } else {
        b.addEventListener("click", () => taps[b.dataset.act!]?.());
      }
    });
  }

  /** Reflect the current look; Photoreal is disabled while loading or when there is no splat. */
  setViewState(view: "splat" | "stylized", splat: "loading" | "ready" | "none") {
    this.root.querySelectorAll<HTMLButtonElement>(".view-switch button").forEach((b) => {
      const isSplat = b.dataset.view === "splat";
      b.setAttribute("aria-pressed", String(b.dataset.view === view));
      if (isSplat) {
        b.textContent = splat === "loading" ? "Photoreal…" : "Photoreal";
        b.title = splat === "none" ? "No photoreal course for this hole" : splat === "loading" ? "Loading" : "";
        b.classList.toggle("unavailable", splat === "none");
      }
    });
  }

  get scorecardOpen(): boolean {
    return !this.els.scorecard.hidden;
  }

  hideScorecard() {
    this.els.scorecard.hidden = true;
  }

  /** Show the scorecard. Scores use card conventions: circle under par, square over. */
  showScorecard(
    card: {
      course: string;
      holes: { number: number; par: number; yards: number; score: number | null }[];
      current: number;
      toPar: number;
      played: number;
    },
    actions: { label: string; primary?: boolean; run: () => void }[],
    onPick: (index: number) => void,
  ) {
    this.set("cardCourse", card.course);
    const rel = card.toPar === 0 ? "E" : card.toPar > 0 ? `+${card.toPar}` : String(card.toPar);
    this.set("cardTotal", card.played ? `${rel} through ${card.played}` : "No holes played yet");
    const t = this.els.cardTable;
    t.replaceChildren();
    const row = (label: string, cells: (string | HTMLElement)[], cls = "") => {
      const tr = document.createElement("tr");
      if (cls) tr.className = cls;
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      tr.append(th);
      for (const c of cells) {
        const td = document.createElement("td");
        if (typeof c === "string") td.textContent = c;
        else td.append(c);
        tr.append(td);
      }
      t.append(tr);
    };
    const totalPar = card.holes.reduce((a, h) => a + h.par, 0);
    const totalYds = card.holes.reduce((a, h) => a + h.yards, 0);
    const strokes = card.holes.reduce((a, h) => a + (h.score ?? 0), 0);
    const holeButtons = card.holes.map((h, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(h.number);
      b.className = i === card.current ? "current" : "";
      b.setAttribute("aria-label", `Play hole ${h.number}`);
      b.addEventListener("click", () => onPick(i));
      return b;
    });
    row("Hole", [...holeButtons, "Tot"], "hole-row");
    row("Yds", [...card.holes.map((h) => String(h.yards)), String(totalYds)]);
    row("Par", [...card.holes.map((h) => String(h.par)), String(totalPar)]);
    row(
      "Score",
      [
        ...card.holes.map((h) => {
          const span = document.createElement("span");
          span.textContent = h.score === null ? "" : String(h.score);
          if (h.score !== null) {
            const d = h.score - h.par;
            span.className = d <= -2 ? "eagle" : d === -1 ? "birdie" : d === 1 ? "bogey" : d >= 2 ? "double" : "par";
          }
          return span;
        }),
        card.played ? String(strokes) : "",
      ],
      "score-row",
    );
    const act = this.els.cardActions;
    act.replaceChildren(
      ...actions.map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        if (a.primary) b.className = "primary";
        b.addEventListener("click", a.run);
        return b;
      }),
    );
    this.els.scorecard.hidden = false;
  }

  /** Data credits (OpenStreetMap's licence requires them to be visible). */
  setCredits(lines: string[]) {
    this.set("credits", lines.join(" · "));
    this.set("creditsShort", lines.some((l) => l.includes("OpenStreetMap")) ? "© OpenStreetMap contributors" : (lines[0] ?? ""));
  }

  /**
   * The 3-click meter. Positions are meter values: 0..1 power, negative = past the
   * accuracy zone (down to -overrun).
   */
  setThreeClick(
    m: {
      marker: number;
      locked: number | null;
      target: number;
      zone: number;
      overrun: number;
      ticks: { power: number; label: string }[];
      readout: string;
    } | null,
  ) {
    const el = this.els.tc;
    if (!m) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const pct = (v: number) => `${((v + m.overrun) / (1 + m.overrun)) * 100}%`;
    this.els.tcZone.style.left = pct(-m.zone);
    this.els.tcZone.style.width = `${((2 * m.zone) / (1 + m.overrun)) * 100}%`;
    this.els.tcTarget.style.left = pct(m.target);
    this.els.tcMarker.style.left = pct(m.marker);
    const fillTo = m.locked ?? Math.max(0, m.marker);
    this.els.tcFill.style.left = pct(0);
    this.els.tcFill.style.width = `${(fillTo / (1 + m.overrun)) * 100}%`;
    this.els.tcFill.classList.toggle("locked", m.locked !== null);
    const key = m.ticks.map((t) => `${t.power.toFixed(3)}${t.label}`).join("|");
    if (this.els.tcTicks.dataset.key !== key) {
      this.els.tcTicks.dataset.key = key;
      this.els.tcTicks.replaceChildren(
        ...m.ticks.map((t) => {
          const d = document.createElement("span");
          d.style.left = pct(t.power);
          d.textContent = t.label;
          return d;
        }),
      );
    }
    this.set("tcReadout", m.readout);
  }

  /** The "3-click for every shot" setting in the scorecard panel. */
  bindThreeClickSetting(initial: boolean, onChange: (all: boolean) => void) {
    const box = this.els.tcAll as HTMLInputElement;
    box.checked = initial;
    box.addEventListener("change", () => onChange(box.checked));
  }

  get coursesOpen(): boolean {
    return !this.els.courses.hidden;
  }

  hideCourses() {
    this.els.courses.hidden = true;
  }

  /** The course list: one card per baked course. */
  showCourses(
    courses: { id: string; name: string; place: string; country: string; holes: number; par: number; yards: number; photorealHoles: number[] }[],
    currentId: string | null,
    onPick: (id: string) => void,
  ) {
    this.els.courseList.replaceChildren(
      ...courses.map((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "course-card" + (c.id === currentId ? " current" : "");
        const name = document.createElement("strong");
        name.textContent = c.name;
        const where = document.createElement("span");
        where.textContent = [c.place, c.country].filter(Boolean).join(", ");
        const facts = document.createElement("span");
        facts.className = "facts";
        facts.textContent = `${c.holes} holes · par ${c.par} · ${c.yards.toLocaleString()} yds`;
        b.append(name, where, facts);
        if (c.photorealHoles.length) {
          const badge = document.createElement("em");
          badge.textContent = `Photoreal hole ${c.photorealHoles.join(", ")}`;
          b.append(badge);
        }
        if (c.id === currentId) b.setAttribute("aria-current", "true");
        b.addEventListener("click", () => onPick(c.id));
        return b;
      }),
    );
    this.hideScorecard();
    this.els.courses.hidden = false;
  }

  hideToast() {
    this.els.toast.classList.remove("show");
  }

  setHelp(text: string) {
    this.set("help", text);
  }

  toast(text: string, ms = 2600) {
    const el = this.els.toast;
    el.textContent = text;
    el.classList.add("show");
    window.clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(window.setTimeout(() => el.classList.remove("show"), ms));
  }

  shotSummary(r: ShotRecord): string {
    if (r.penalty === "water") return "Splash! Water hazard — 1 stroke penalty";
    if (r.penalty === "out-of-bounds") return "Out of bounds — stroke and distance";
    const what = r.club === "PT" ? `${(r.total * 3.28084).toFixed(0)} ft putt` : `${yd(r.total)} yds (carry ${yd(r.carry)})`;
    return `${what} · ${LIE_NAMES[r.lie] ?? r.lie}`;
  }

  scoreName(strokes: number, par: number): string {
    if (strokes === 1) return "Hole in one!";
    return SCORE_NAMES[strokes - par] ?? `+${strokes - par}`;
  }
}
