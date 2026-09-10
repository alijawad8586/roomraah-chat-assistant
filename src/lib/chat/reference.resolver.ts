/**
 * Turning the words a person used into the ids the search takes.
 *
 * Somebody types "wifi aur mess"; `GET /properties` wants `facilityIds=1,2`. This is the
 * only place that translation happens, so the chatbot never has to know that facility 1 is
 * called "Wi-Fi" and the ranker never has to guess what "ac" meant.
 *
 * The catalogue itself is not fetched here. `ReferenceService.facilities()` already asks for
 * it once and shares the answer with every subscriber for the life of the session, and the
 * filter panel and the listing form are already subscribers - so a chatbot that went to the
 * network on its own would be the second request for a list the app is already holding.
 */
import { Injectable, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { Facility, PropertyDetail } from '../models/catalog.model';
import { ReferenceService } from '../services/reference.service';

@Injectable({ providedIn: 'root' })
export class ReferenceResolver {
  private readonly reference = inject(ReferenceService);

  /**
   * The facility catalogue, fetched at most once per session.
   *
   * The caching is `ReferenceService`'s, not a second copy of it: that service holds the
   * stream in a field and returns it with `shareReplay({ bufferSize: 1, refCount: false })`,
   * so every later caller - here or on the search page - gets the held answer rather than a
   * new request.
   */
  getFacilities(): Observable<Facility[]> {
    return this.reference.facilities();
  }

  /**
   * The ids for the facilities a person named. Names that match nothing are dropped rather
   * than refused: "wifi aur ghar ka khana" should search for wifi, not fail because the
   * catalogue has no facility for home cooking.
   */
  resolveFacilityNames(names: string[]): Observable<number[]> {
    // Nothing asked for is not a reason to touch the network at all.
    if (names.length === 0) return of([]);
    return this.getFacilities().pipe(map((facilities) => matchFacilityIds(facilities, names)));
  }
}

/**
 * Reduces a facility name to something two spellings of the same thing agree on: case and
 * punctuation are dropped, so "Wi-Fi", "wi fi" and "WIFI" all become `wifi`.
 *
 * This is not defensive over-engineering - it is what the live catalogue requires. A plain
 * case-insensitive comparison against `name` matches "mess" and misses "wifi" outright,
 * because the seeded name is "Wi-Fi" and nobody types the hyphen.
 */
export function normaliseFacilityToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Matches names against the catalogue and returns the ids, in the order the person said
 * them, without repeats.
 *
 * Each facility is matched on two spellings: its `name` and its `iconKey`. The second is
 * what makes "ac" work - the catalogue calls facility 3 "Air Conditioning", which nobody
 * types, but its `iconKey` is already the short form ("ac", "wifi", "power-backup"). Both
 * are compared normalised, so this stays an exact match on a normalised token rather than a
 * substring search: "car parking" should not silently match "Parking", because it might
 * equally have meant something the catalogue does not have.
 *
 * Pure, so it can be tested without the injector or a fake HTTP backend.
 */
export function matchFacilityIds(
  facilities: readonly Facility[],
  names: readonly string[],
): number[] {
  const byToken = new Map<string, number>();
  for (const facility of facilities) {
    byToken.set(normaliseFacilityToken(facility.name), facility.id);
    // The name wins where both spellings normalise the same, which costs nothing and keeps
    // the mapping predictable if a future iconKey collides with another facility's name.
    const iconToken = normaliseFacilityToken(facility.iconKey);
    if (!byToken.has(iconToken)) byToken.set(iconToken, facility.id);
  }

  const ids: number[] = [];
  for (const name of names) {
    const id = byToken.get(normaliseFacilityToken(name));
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The map `rankProperties` takes as `knownFacilities`: property id to the facility names
 * that property has.
 *
 * It is built from listing details, not from the facility catalogue, because the catalogue
 * does not know which property has what - see the note in `reference.resolver.spec.ts` and
 * the report accompanying this file. `PropertyCard` carries no facilities either, so the
 * caller has to have fetched `GET /properties/{id}` for the listings it wants measured,
 * which the chat flow only does for the handful it is about to show.
 *
 * Pure: it does no fetching of its own, so the caller decides how many details are worth
 * asking for.
 */
export function buildKnownFacilitiesMap(
  details: readonly PropertyDetail[],
): ReadonlyMap<number, readonly string[]> {
  const map = new Map<number, readonly string[]>();
  for (const detail of details) {
    map.set(
      detail.id,
      detail.facilities.map((facility) => facility.name),
    );
  }
  return map;
}
