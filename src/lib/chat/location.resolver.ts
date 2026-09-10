/**
 * Working out where "mere nazdeek" is.
 *
 * Three things have to line up before a nearby search can run: a position to measure from, a
 * city to search inside, and a graceful answer when neither is available. The API has no
 * "listings near this point" endpoint - `PropertyFilters` takes `cityId`, `areaId` or a
 * seeded `landmarkId` and nothing else - so a pair of coordinates is only useful once it has
 * been turned into a city, and that translation is what most of this file is.
 *
 * The position itself is not asked for here. `GeolocationService` already owns it for the
 * whole application - the header's location chip reads the same signals - and a second
 * asker would mean a second permission prompt and a second cache that disagreed with the
 * first. This file reads that service and adds nothing of its own to it.
 */
import { Injectable, computed, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable, of } from 'rxjs';
import { filter, map, switchMap, take } from 'rxjs/operators';
import { City } from '../models/catalog.model';
import { LocationResolution, UserCoords } from '../models/chat.model';
import { GeolocationService } from '../services/geolocation.service';
import { ReferenceService } from '../services/reference.service';
import { haversineKm } from '../utils/geo.util';

/**
 * The cities RoomRaah actually has, with a centre point for each.
 *
 * Taken from a live `GET /api/v1/locations/cities`, which returns exactly three - Lahore,
 * Karachi and Islamabad. The ids are deliberately not written down here: they are looked up
 * against the live list, because a hard-coded id would silently point at the wrong city if
 * the database were ever reseeded. Only the coordinates are static, and those do not move.
 *
 * This table exists because the API cannot answer "which city is this point in", and a
 * geocoding service would be a network dependency and a key for a question with three
 * possible answers.
 */
export const CITY_CENTROIDS: readonly { name: string; lat: number; lng: number }[] = [
  { name: 'Lahore', lat: 31.5204, lng: 74.3587 },
  { name: 'Karachi', lat: 24.8607, lng: 67.0011 },
  { name: 'Islamabad', lat: 33.6844, lng: 73.0479 },
];

/**
 * How far from a city centre still counts as being in it.
 *
 * Generous on purpose - it has to cover the whole of Karachi and reach Rawalpindi from
 * Islamabad - but far short of the ~1000 km between the two nearest cities on the list, so
 * somebody in Quetta is answered with "no city" rather than with Karachi.
 */
export const MAX_CITY_MATCH_KM = 150;

/** What the shared position state resolves to once it has stopped being undecided. */
interface Settlement {
  settled: boolean;
  coords: UserCoords | null;
}

@Injectable({ providedIn: 'root' })
export class LocationResolver {
  private readonly reference = inject(ReferenceService);
  private readonly geo = inject(GeolocationService);

  /**
   * The shared position state, reduced to the only question this file asks of it: has it
   * finished deciding, and if so what did it decide?
   *
   * `GeolocationService.state` has five values and only three of them are answers.
   * `granted`, `denied` and `unavailable` are terminal; `idle` means nobody has asked yet
   * and `asking` means somebody has and the browser has not replied. Both of those are "not
   * yet", and both are waited on rather than treated as a refusal.
   */
  private readonly settlement = computed<Settlement>(() => {
    if (this.geo.hasPosition()) return { settled: true, coords: this.geo.position() };

    const state = this.geo.state();
    // `granted` without a position cannot happen, but if it ever did this stops the wait
    // below from hanging forever on a state that will never change again.
    if (state === 'denied' || state === 'unavailable' || state === 'granted') {
      return { settled: true, coords: null };
    }
    return { settled: false, coords: null };
  });

  /**
   * The bridge from signals to rxjs, made once.
   *
   * `GeolocationService` answers in signals and its `request()` returns `void` - it sets
   * `state` to `asking` and the browser's callback later writes `position` and `state`. There
   * is nothing to subscribe to and nothing to await, so the transition has to be observed
   * rather than returned. `toObservable` does exactly that: it watches `settlement` and
   * emits whenever it changes, which is how a `void` imperative call becomes something
   * `resolveLocation` can compose with.
   *
   * It is built in a field initializer because `toObservable` needs an injection context,
   * and it is built once rather than per call because an effect per message would be a leak.
   */
  private readonly settlement$ = toObservable(this.settlement);

  /**
   * The position, waiting for it only if it is still being decided.
   *
   * The synchronous short-circuit is the common case and matters: once anyone has granted
   * the permission - the header chip, or an earlier message - this returns immediately from
   * the signal, with no effect scheduling and no second prompt.
   */
  private currentPosition(): Observable<UserCoords | null> {
    const now = this.settlement();
    if (now.settled) return of(now.coords);

    // `idle` means nobody has asked yet, so this asks. `asking` means somebody already has -
    // the header chip, most likely - and asking again would be a second prompt for an answer
    // already on its way, so this only waits.
    if (this.geo.state() === 'idle') this.geo.request();

    return this.settlement$.pipe(
      filter((s) => s.settled),
      take(1),
      map((s) => s.coords),
    );
  }

  /**
   * The id of the city a point sits in, or null when it sits in none of them.
   *
   * Null is a real answer, not a failure: RoomRaah has listings in three cities, and
   * somebody opening the chatbot from Multan should be told there is nothing near them
   * rather than shown Lahore as though it were nearby.
   */
  resolveCityFromCoords(coords: UserCoords): Observable<number | null> {
    const nearest = nearestCentroid(coords);
    if (!nearest) return of(null);

    return this.reference.cities().pipe(map((cities) => findCityIdByName(cities, nearest.name)));
  }

  /**
   * The fallback chain, in the order that costs the person the least.
   *
   * The shared position first, because it needs no typing and gives a real distance. The
   * place they named second, because it still narrows the search to a city even though it
   * cannot say how far anything is from them. Nothing third, which is the caller's cue to
   * ask one short question.
   */
  resolveLocation(landmarkOrCityText?: string): Observable<LocationResolution> {
    return this.currentPosition().pipe(
      switchMap((coords) => {
        if (coords) {
          return this.resolveCityFromCoords(coords).pipe(
            map((cityId) => {
              // A position outside all three cities is still a position: distances are real
              // even when there is no city to search inside, and the caller is told so by
              // the missing `cityId` rather than by losing the coordinates.
              const resolution: LocationResolution = { coords, source: 'gps' };
              if (cityId != null) resolution.cityId = cityId;
              return resolution;
            }),
          );
        }

        const text = landmarkOrCityText?.trim();
        if (!text) return of<LocationResolution>({ source: 'manual' });

        return this.resolveCityFromText(text);
      }),
    );
  }

  /**
   * A typed place turned into a city id.
   *
   * `GET /locations/suggest` mixes three kinds of place in one list and they carry the id
   * differently: on a `City` the id *is* the city id, while a `Landmark` or an `Area` carries
   * a landmark or area id and names its city in `city`. Reading the id without reading
   * `type` first would search area 4 as though it were a city.
   */
  private resolveCityFromText(text: string): Observable<LocationResolution> {
    return this.reference.suggest(text).pipe(
      switchMap((suggestions) => {
        const city = suggestions.find((s) => s.type === 'City');
        if (city) {
          return of<LocationResolution>({ cityId: city.id, source: 'landmark' });
        }

        const named = suggestions.find((s) => !!s.city);
        if (!named?.city) return of<LocationResolution>({ source: 'manual' });

        return this.reference.cities().pipe(
          map((cities) => {
            const cityId = findCityIdByName(cities, named.city as string);
            return cityId == null
              ? ({ source: 'manual' } as LocationResolution)
              : ({ cityId, source: 'landmark' } as LocationResolution);
          }),
        );
      }),
    );
  }
}

/** The nearest centroid, or nothing at all when the nearest is still too far to mean it. */
export function nearestCentroid(coords: UserCoords): { name: string; distanceKm: number } | null {
  let best: { name: string; distanceKm: number } | null = null;

  for (const centroid of CITY_CENTROIDS) {
    const distanceKm = haversineKm(coords, centroid);
    if (!best || distanceKm < best.distanceKm) best = { name: centroid.name, distanceKm };
  }

  if (!best || best.distanceKm > MAX_CITY_MATCH_KM) return null;
  return best;
}

/** Matched on name because the ids belong to the database, not to this file. */
function findCityIdByName(cities: readonly City[], name: string): number | null {
  const needle = name.trim().toLowerCase();
  return cities.find((city) => city.name.trim().toLowerCase() === needle)?.id ?? null;
}
