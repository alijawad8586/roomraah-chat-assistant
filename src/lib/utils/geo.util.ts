/**
 * Distance between two points on the earth, and nothing else.
 *
 * This lived in two places once - `geolocation.service.ts` measured a listing from the
 * person, and `ranker.ts` measured the same listing again to score it - which meant two
 * copies of one formula that had to stay identical by hand. They are the same measurement,
 * so they are now the same function.
 *
 * It is here rather than in either of them because both need it and neither owns it, and it
 * is deliberately free of Angular: `geolocation.service.ts` declares an `@Injectable` whose
 * decorator runs on import, and the ranker is meant to stay a pure module that can be tested
 * without the injector.
 *
 * It imports nothing at all, which is the point. A shared utility that reaches into a
 * feature's model for its parameter type drags that feature behind it: geolocation predates
 * the chatbot by a long way and has no business depending on the chatbot's vocabulary.
 */

/**
 * A point on the earth, in degrees. Declared here rather than borrowed so that this file
 * stays dependency-free. `Coords` in `geolocation.service.ts` and `UserCoords` in
 * `chat.model.ts` are the same shape, and TypeScript is structural, so both are accepted
 * here without a cast or an import in either direction.
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Mean radius. The same figure both copies used, so no distance changes by moving here. */
const EARTH_RADIUS_KM = 6371;

/**
 * Straight-line kilometres between two points - the "as the crow flies" distance of rule 13,
 * not a walking or driving route. Good to a few metres at city scale, which is every scale
 * this application works at.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
