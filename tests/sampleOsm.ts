// A synthetic three-hole course in Overpass JSON form, for tests and for developing the
// stylized renderer without network access. It is not a real course.
import { makeProjection } from "../src/geo/projection";
import type { OsmElement } from "../src/course/osm";

type P = [number, number];
const ORIGIN = { lat: 54.3405, lon: -1.452 };
const proj = makeProjection(ORIGIN);
const ll = ([x, z]: P) => proj.toLatLon(x, z);
const ring = (pts: P[]) => [...pts, pts[0]].map(ll);

function ellipse(cx: number, cz: number, rx: number, rz: number, rot = 0, n = 24): P[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    const x = rx * Math.cos(t);
    const z = rz * Math.sin(t);
    return [cx + x * Math.cos(rot) - z * Math.sin(rot), cz + x * Math.sin(rot) + z * Math.cos(rot)];
  });
}

/** Offset a centre line to a closed corridor with a width that can vary along it. */
function corridor(line: P[], width: (t: number) => number, step = 8): P[] {
  const pts: P[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  pts.push(line[line.length - 1]);
  const left: P[] = [];
  const right: P[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / len;
    const nz = (b[0] - a[0]) / len;
    const w = width(i / (pts.length - 1)) / 2;
    left.push([p[0] - nx * w, p[1] - nz * w]);
    right.push([p[0] + nx * w, p[1] + nz * w]);
  });
  return [...left, ...right.reverse()];
}

let nextId = 1;
const way = (tags: Record<string, string>, pts: P[], closed = true): OsmElement => ({
  type: "way",
  id: nextId++,
  tags,
  geometry: closed ? ring(pts) : pts.map(ll),
});
const node = (tags: Record<string, string>, p: P): OsmElement => {
  const g = ll(p);
  return { type: "node", id: nextId++, tags, lat: g.lat, lon: g.lon };
};

export function sampleCourseOsm(): { elements: OsmElement[] } {
  nextId = 1;
  const h1: P[] = [[0, 0], [0, -230], [62, -352]];
  const h2: P[] = [[96, -338], [252, -330]];
  const h3: P[] = [[292, -300], [300, -60], [238, 138]];
  const elements: OsmElement[] = [
    way({ leisure: "golf_course", name: "Sample Course (synthetic)" }, [[-95, 45], [-95, -430], [365, -430], [365, 215], [150, 215]]),

    // Hole 1: dogleg-right par 4.
    way({ golf: "hole", ref: "1", par: "4" }, h1, false),
    way({ golf: "tee" }, [[-6, 6], [6, 6], [6, -14], [-6, -14]]),
    way({ golf: "fairway" }, corridor([[0, -45], [0, -230], [52, -330]], (t) => 30 + 10 * Math.sin(Math.PI * t))),
    way({ golf: "green" }, ellipse(62, -352, 14, 18, 0.5)),
    way({ golf: "bunker" }, ellipse(24, -238, 7, 11, 0.3)),
    way({ golf: "bunker" }, ellipse(-20, -205, 6, 9)),
    way({ golf: "bunker" }, ellipse(42, -368, 5, 9, -0.4)),
    way({ golf: "bunker" }, ellipse(82, -338, 5, 8, 0.6)),
    node({ golf: "pin" }, [60, -355]),

    // Hole 2: par 3 over water.
    way({ golf: "hole", ref: "2", par: "3" }, h2, false),
    way({ golf: "tee" }, [[88, -332], [104, -332], [104, -344], [88, -344]]),
    way({ golf: "water_hazard" }, ellipse(178, -334, 32, 20, 0.15, 28)),
    way({ golf: "green" }, ellipse(252, -330, 15, 13)),
    way({ golf: "bunker" }, ellipse(250, -310, 9, 4)),
    way({ golf: "bunker" }, ellipse(270, -344, 4, 7, 0.4)),

    // Hole 3: par 5 back towards the clubhouse.
    way({ golf: "hole", ref: "3", par: "5" }, h3, false),
    way({ golf: "tee" }, [[286, -292], [298, -292], [298, -312], [286, -312]]),
    way({ golf: "fairway" }, corridor([[294, -260], [300, -60], [246, 112]], (t) => 34 + 8 * Math.cos(2 * Math.PI * t))),
    way({ golf: "green" }, ellipse(238, 138, 16, 14, -0.3)),
    way({ golf: "bunker" }, ellipse(318, -120, 8, 12)),
    way({ golf: "bunker" }, ellipse(272, -20, 7, 10, 0.5)),
    way({ golf: "bunker" }, ellipse(215, 126, 5, 9, 0.2)),
    way({ golf: "bunker" }, ellipse(258, 155, 8, 4, -0.3)),

    // Scenery.
    way({ natural: "wood" }, [[120, -250], [215, -260], [235, 40], [150, 110], [118, 20]]),
    way({ natural: "scrub" }, [[-80, -300], [-45, -310], [-40, -380], [-85, -390]]),
    way({ natural: "tree_row" }, [[-70, 30], [-75, -260]], false),
    ...[[-35, -90], [38, -140], [-32, -280], [100, -270], [330, -250], [335, 40], [190, 175]].map((p) =>
      node({ natural: "tree" }, p as P),
    ),
  ];
  return { elements };
}
