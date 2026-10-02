/** Local tangent-plane projection (equirectangular) around a course origin.
 * Accurate to well under 0.1% across a golf course, which is all the game needs.
 * Output axes match the hole frame used everywhere else: +X east, +Y up, -Z north. */
const EARTH_RADIUS_M = 6_378_137;

export interface LatLon {
  lat: number;
  lon: number;
}

export function makeProjection(origin: LatLon) {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  return {
    toLocal(p: LatLon): { x: number; z: number } {
      return { x: (p.lon - origin.lon) * k * cosLat, z: -(p.lat - origin.lat) * k };
    },
    toLatLon(x: number, z: number): LatLon {
      return { lat: origin.lat - z / k, lon: origin.lon + x / (k * cosLat) };
    },
  };
}
