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
      <div class="toast" data-k="toast"></div>
      <div class="help" data-k="help"></div>
      <div class="panel view" data-k="view"></div>
      <div class="controls" role="toolbar" aria-label="Shot controls">
        <button type="button" data-hold="-1" aria-label="Aim left">◀</button>
        <button type="button" data-act="clubUp" aria-label="Longer club">▲</button>
        <button type="button" data-hold="1" aria-label="Aim right">▶</button>
        <button type="button" data-act="overhead" aria-label="Overhead view">⌖</button>
        <button type="button" data-act="clubDown" aria-label="Shorter club">▼</button>
        <button type="button" data-act="toggleView" aria-label="Photoreal or stylized view">◐</button>
        <button type="button" data-act="skip" aria-label="Skip flyover or ball flight">⏭</button>
        <button type="button" data-act="restart" aria-label="Restart hole">↺</button>
      </div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => (this.els[el.dataset.k!] = el));
  }

  private set(k: string, text: string) {
    if (this.els[k].textContent !== text) this.els[k].textContent = text;
  }

  update(s: HoleSession, courseName: string, viewLabel: string) {
    this.set("hole", String(s.hole.number));
    this.set("course", courseName);
    this.set("par", `Par ${s.hole.par} · ${s.hole.lengthYards} yds`);
    this.set("stroke", String(Math.max(1, s.strokes + (s.phase === "holed" ? 0 : 1))));
    this.set("club", s.club.name);
    const carry = s.club.isPutter ? `Range ${yd(s.puttRange)} yds` : `Carry ${yd(s.carries.get(s.club.id) ?? 0)} yds`;
    this.set("carry", carry);
    this.set("lie", `Lie: ${LIE_NAMES[s.lie] ?? s.lie}`);
    const d = s.distanceToPin;
    this.set("toPin", s.lie === "green" && d < 30 ? `${(d * 3.28084).toFixed(0)} ft` : `${yd(d)} yds`);
    this.set("view", viewLabel);
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
    toggleView(): void;
    skip(): void;
    restart(): void;
  }) {
    const taps: Record<string, () => void> = {
      clubUp: () => a.club(-1),
      clubDown: () => a.club(1),
      overhead: a.overhead,
      toggleView: a.toggleView,
      skip: a.skip,
      restart: a.restart,
    };
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
