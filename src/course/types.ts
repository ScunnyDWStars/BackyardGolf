import type { Vec3 } from "../math/vec3";

export type Lie = "tee" | "fairway" | "rough" | "green" | "bunker" | "water" | "out-of-bounds";

/** A polygon on the ground plane, as [x, z] pairs in hole-frame metres. */
export type Polygon2 = [number, number][];

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
}

export interface HoleData {
  number: number;
  par: number;
  lengthYards: number;
  tee: Vec3;
  pin: Vec3;
  /** Centre line from tee to green, used for camera flyovers and aiming defaults. */
  centerline: [number, number][];
  /** Polygons by lie, highest priority first is resolved by TerrainModel. */
  areas: { lie: Lie; polygon: Polygon2 }[];
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
  holes: HoleData[];
  splat?: SplatInfo;
}
