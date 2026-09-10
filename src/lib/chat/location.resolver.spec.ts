import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injectable, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_API_BASE_URL } from '../chat-config';

import { City, LocationSuggestion } from '../models/catalog.model';
import { LocationResolution, UserCoords } from '../models/chat.model';
import { Coords, GeolocationService, GeolocationState } from '../services/geolocation.service';
import {
  CITY_CENTROIDS,
  LocationResolver,
  MAX_CITY_MATCH_KM,
  nearestCentroid,
} from './location.resolver';

const API_BASE = 'http://test.local/api/v1';

/** Exactly what the deployed API returns - three cities, and not in id order. */
const CITIES: City[] = [
  { id: 3, name: 'Islamabad' },
  { id: 2, name: 'Karachi' },
  { id: 1, name: 'Lahore' },
];

const CITIES_URL = `${API_BASE}/locations/cities`;
const SUGGEST_URL = `${API_BASE}/locations/suggest`;

const LAHORE: UserCoords = { lat: 31.5204, lng: 74.3587 };
const KARACHI: UserCoords = { lat: 24.8607, lng: 67.0011 };
/** Far from all three, and deliberately not abroad: RoomRaah simply has nothing there. */
const QUETTA: UserCoords = { lat: 30.1798, lng: 66.975 };

/**
 * A stand-in for the real service with the same signals and the same imperative `request()`.
 *
 * `navigator.geolocation` is not mocked here on purpose: after the bridge, the resolver has
 * no opinion about the browser at all - it reads shared state. Faking the browser instead of
 * the service would be testing a path the resolver no longer has, and would pass even if the
 * resolver went back to prompting on its own.
 */
@Injectable()
class FakeGeolocationService {
  readonly position = signal<Coords | null>(null);
  readonly state = signal<GeolocationState>('idle');
  readonly hasPosition = computed(() => this.position() !== null);

  /** Records the call; the test decides when and how the browser "answers". */
  readonly request = vi.fn<() => void>(() => {
    this.state.set('asking');
  });

  readonly forget = vi.fn<() => void>(() => {
    this.position.set(null);
    this.state.set('idle');
  });

  /** The browser coming back, later, the way it really does. */
  grant(coords: Coords): void {
    this.position.set(coords);
    this.state.set('granted');
  }

  deny(): void {
    this.position.set(null);
    this.state.set('denied');
  }
}

describe('CITY_CENTROIDS', () => {
  /** Invented cities would send every search to a city id that resolves to nothing. */
  it('covers exactly the cities the API seeds', () => {
    expect(CITY_CENTROIDS.map((c) => c.name).sort()).toEqual(['Islamabad', 'Karachi', 'Lahore']);
  });
});

describe('nearestCentroid', () => {
  it('picks the city a point is actually in', () => {
    expect(nearestCentroid(LAHORE)?.name).toBe('Lahore');
    expect(nearestCentroid(KARACHI)?.name).toBe('Karachi');
    expect(nearestCentroid({ lat: 33.6844, lng: 73.0479 })?.name).toBe('Islamabad');
  });

  /** Rawalpindi is a different city to a person and the same one to a search. */
  it('still reaches a neighbouring town inside the radius', () => {
    const hit = nearestCentroid({ lat: 33.5651, lng: 73.0169 });
    expect(hit?.name).toBe('Islamabad');
    expect(hit?.distanceKm).toBeLessThan(MAX_CITY_MATCH_KM);
  });

  it('answers nothing rather than guessing for a point in no city', () => {
    expect(nearestCentroid(QUETTA)).toBeNull();
  });
});

describe('LocationResolver', () => {
  let resolver: LocationResolver;
  let httpMock: HttpTestingController;
  let geo: FakeGeolocationService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CHAT_API_BASE_URL, useValue: API_BASE },
        FakeGeolocationService,
        { provide: GeolocationService, useExisting: FakeGeolocationService },
      ],
    });
    geo = TestBed.inject(FakeGeolocationService);
    resolver = TestBed.inject(LocationResolver);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('resolveCityFromCoords', () => {
    it('turns a position into the id the live list gives that city', () => {
      let cityId: number | null | undefined;
      resolver.resolveCityFromCoords(LAHORE).subscribe((id) => (cityId = id));
      httpMock.expectOne(CITIES_URL).flush(CITIES);
      expect(cityId).toBe(1);
    });

    it('reads the id from the response rather than assuming it', () => {
      let cityId: number | null | undefined;
      resolver.resolveCityFromCoords(KARACHI).subscribe((id) => (cityId = id));
      httpMock.expectOne(CITIES_URL).flush(CITIES);
      expect(cityId).toBe(2);
    });

    it('does not even ask for the list when the point is in no city', () => {
      let cityId: number | null | undefined;
      resolver.resolveCityFromCoords(QUETTA).subscribe((id) => (cityId = id));
      httpMock.expectNone(CITIES_URL);
      expect(cityId).toBeNull();
    });

    it('answers null when the live list has no city by that name', () => {
      let cityId: number | null | undefined;
      resolver.resolveCityFromCoords(LAHORE).subscribe((id) => (cityId = id));
      httpMock.expectOne(CITIES_URL).flush([{ id: 9, name: 'Multan' }] as City[]);
      expect(cityId).toBeNull();
    });
  });

  describe('resolveLocation — reading the shared position', () => {
    /**
     * The whole point of the bridge: somebody already granted it, so this must not prompt
     * again. If the resolver kept its own permission state this would call `request()`.
     */
    it('uses a position that is already held, without asking again', () => {
      geo.grant(LAHORE);

      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));
      httpMock.expectOne(CITIES_URL).flush(CITIES);

      expect(geo.request).not.toHaveBeenCalled();
      expect(result).toEqual({ coords: LAHORE, cityId: 1, source: 'gps' });
    });

    /**
     * The imperative half of the bridge. `request()` returns void and the browser answers
     * later by writing the signals; `TestBed.tick()` is what flushes that change through
     * `toObservable` here, standing in for the browser callback arriving.
     */
    it('asks once when nobody has yet, and waits for the answer', () => {
      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));

      expect(geo.request).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined(); // still 'asking' - nothing decided yet

      geo.grant(LAHORE);
      TestBed.tick();
      httpMock.expectOne(CITIES_URL).flush(CITIES);

      expect(result).toEqual({ coords: LAHORE, cityId: 1, source: 'gps' });
    });

    /** The header chip is mid-prompt. A second `request()` would be a second dialog. */
    it('waits rather than asking again when a prompt is already open', () => {
      geo.state.set('asking');

      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));

      expect(geo.request).not.toHaveBeenCalled();

      geo.grant(KARACHI);
      TestBed.tick();
      httpMock.expectOne(CITIES_URL).flush(CITIES);

      expect(result).toEqual({ coords: KARACHI, cityId: 2, source: 'gps' });
    });

    it('keeps the coordinates when the position is in no seeded city', () => {
      geo.grant(QUETTA);

      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));

      expect(result).toEqual({ coords: QUETTA, source: 'gps' });
      expect(result).not.toHaveProperty('cityId');
    });

    /** Over plain http the service reports this from its constructor and never prompts. */
    it('does not prompt when the browser cannot provide a position at all', () => {
      geo.state.set('unavailable');

      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));

      expect(geo.request).not.toHaveBeenCalled();
      expect(result).toEqual({ source: 'manual' });
    });

    it('does not prompt again once the person has refused', () => {
      geo.deny();

      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));

      expect(geo.request).not.toHaveBeenCalled();
      expect(result).toEqual({ source: 'manual' });
    });
  });

  describe('resolveLocation — the fallback chain', () => {
    it('ignores typed text when a real position is held', () => {
      geo.grant(LAHORE);

      let result: LocationResolution | undefined;
      resolver.resolveLocation('karachi').subscribe((r) => (result = r));
      httpMock.expectOne(CITIES_URL).flush(CITIES);

      expect(result).toEqual({ coords: LAHORE, cityId: 1, source: 'gps' });
      httpMock.expectNone((r) => r.url === SUGGEST_URL);
    });

    /** `type: 'City'` is the one case where the suggestion's id is already a city id. */
    it('falls back to a named city when the position was refused', () => {
      geo.deny();

      let result: LocationResolution | undefined;
      resolver.resolveLocation('lahore').subscribe((r) => (result = r));

      const suggestions: LocationSuggestion[] = [
        { type: 'City', id: 1, name: 'Lahore' },
        { type: 'Landmark', id: 2, name: 'UET Lahore', city: 'Lahore', kind: 'University' },
      ];
      httpMock.expectOne((r) => r.url === SUGGEST_URL).flush(suggestions);

      expect(result).toEqual({ cityId: 1, source: 'landmark' });
    });

    /**
     * A landmark's own id is a landmark id, not a city id. Reading it without checking
     * `type` would search city 4 for a query that meant landmark 4.
     */
    it('reads a landmark through its city name, not through its own id', () => {
      geo.deny();

      let result: LocationResolution | undefined;
      resolver.resolveLocation('university of karachi').subscribe((r) => (result = r));

      const suggestions: LocationSuggestion[] = [
        {
          type: 'Landmark',
          id: 4,
          name: 'University of Karachi',
          city: 'Karachi',
          kind: 'University',
        },
      ];
      httpMock.expectOne((r) => r.url === SUGGEST_URL).flush(suggestions);
      httpMock.expectOne(CITIES_URL).flush(CITIES);

      expect(result).toEqual({ cityId: 2, source: 'landmark' });
    });

    it('asks the person when the position failed and nothing was named', () => {
      geo.deny();

      let result: LocationResolution | undefined;
      resolver.resolveLocation().subscribe((r) => (result = r));

      expect(result).toEqual({ source: 'manual' });
      httpMock.expectNone((r) => r.url === SUGGEST_URL);
    });

    it('asks the person when what they named matched nothing', () => {
      geo.deny();

      let result: LocationResolution | undefined;
      resolver.resolveLocation('atlantis').subscribe((r) => (result = r));
      httpMock.expectOne((r) => r.url === SUGGEST_URL).flush([]);

      expect(result).toEqual({ source: 'manual' });
    });

    it('treats blank text as nothing named', () => {
      geo.deny();

      let result: LocationResolution | undefined;
      resolver.resolveLocation('   ').subscribe((r) => (result = r));

      expect(result).toEqual({ source: 'manual' });
      httpMock.expectNone((r) => r.url === SUGGEST_URL);
    });
  });
});
