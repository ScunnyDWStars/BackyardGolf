import type { Vec3 } from "../math/vec3";

export type Lie = "tee" | "fairway" | "rough" | "green" | "bunker" | "water" | "out-of-bounds";

/** A polygon on the ground plane, as [x, z] pairs in hole-frame metres. */
export type Polygon2 = [number, number][];

export interface Area {
  lie: Lie;
  polygon: Polygon2;
  /** Cut-outs (e.g. gorse or rough islands inside a links fairway). */
  holes?: Polygon2[];
}

/** Scenery from the map: individual trees, woods/scrub to fill, and tree rows. */
export interface CourseFeatures {
  trees?: [number, number][];
  woods?: { kind: "wood" | "scrub"; polygon: Polygon2 }[];
  treeRows?: [number, number][][];
}

export interface Heightfield {
  /** World x/z of grid cell (0, 0). */
  originX: number;
  originZ: number;
  /** Metres between samples. */
  cellSize: number;
  cols: number;
  rows: number;
  /** Row-major heights in metres, rows along +Z. */
  heights: number[];
}

export interface SplatInfo {
  /** URL of a .ply/.spz. Not shipped in the repo; supplied locally by the player. */
  url?: string;
  /** Row-major 4x4 transform from the splat's file frame into the hole frame. */
  matrix: number[][];
  /** Hole numbers the capture covers; omitted means every hole. */
  holes?: number[];
}

export interface HoleData {
  number: number;
  name?: string;
  par: number;
  lengthYards: number;
  tee: Vec3;
  pin: Vec3;
  /** Centre line from tee to green, used for camera flyovers and aiming defaults. */
  centerline: [number, number][];
  /** Polygons by lie for this hole only; overlaps are resolved by TerrainModel. */
  areas: Area[];
}

export interface CourseData {
  name: string;
  /** Where the data came from; shown in credits. */
  attribution: string[];
  /** Geographic origin of the hole frame, when known. */
  origin?: { lat: number; lon: number; headingDeg?: number };
  heightfield: Heightfield;
  /** Playable boundary; outside is out of bounds. */
  bounds: Polygon2;
  /** Lie polygons shared by the whole course (from map data). */
  areas?: Area[];
  features?: CourseFeatures;
  holes: HoleData[];
  splat?: SplatInfo;
}
