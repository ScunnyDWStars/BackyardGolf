import type { CourseData } from "../course/types";
import type { Vec3 } from "../math/vec3";
import { HoleSession } from "./session";

/** A round over a course's holes: which hole is being played, and the scorecard. */
export class Round {
  readonly scores: (number | null)[];
  holeIndex = 0;
  session: HoleSession;

  constructor(
    readonly course: CourseData,
    private readonly wind: Vec3,
    startIndex = 0,
  ) {
    this.scores = course.holes.map(() => null);
    this.holeIndex = startIndex;
    this.session = new HoleSession(course, startIndex, wind);
  }

  /** Start (or restart) a hole. Restarting clears that hole's score. */
  play(index: number): HoleSession {
    this.holeIndex = index;
    this.scores[index] = null;
    this.session = new HoleSession(this.course, index, this.wind);
    return this.session;
  }

  /** Record the current hole once it is holed. */
  record() {
    if (this.session.phase === "holed") this.scores[this.holeIndex] = this.session.strokes;
  }

  /** The next hole without a score, after the current one (wrapping), or null when done. */
  nextIndex(): number | null {
    const n = this.scores.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.holeIndex + k) % n;
      if (this.scores[i] === null) return i;
    }
    return null;
  }

  totals() {
    let strokes = 0;
    let par = 0;
    let played = 0;
    this.scores.forEach((s, i) => {
      if (s === null) return;
      strokes += s;
      par += this.course.holes[i].par;
      played++;
    });
    return { strokes, par, toPar: strokes - par, played };
  }
}
