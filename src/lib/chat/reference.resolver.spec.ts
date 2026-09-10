import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { CHAT_API_BASE_URL } from '../chat-config';

import { Facility, PropertyCard, PropertyDetail } from '../models/catalog.model';
import { SearchIntent } from '../models/chat.model';
import { rankProperties } from './ranker';
import {
  ReferenceResolver,
  buildKnownFacilitiesMap,
  matchFacilityIds,
  normaliseFacilityToken,
} from './reference.resolver';

const API_BASE = 'http://test.local/api/v1';

/**
 * The facility catalogue exactly as the deployed API serves it. Copied from a live
 * `GET /api/v1/facilities` rather than invented, because the whole difficulty of this file
 * is that the seeded names are not the words people type: the catalogue says "Wi-Fi" and
 * "Air Conditioning", and a person types "wifi" and "ac".
 */
const FACILITIES: Facility[] = [
  { id: 1, name: 'Wi-Fi', iconKey: 'wifi' },
  { id: 2, name: 'Mess', iconKey: 'mess' },
  { id: 3, name: 'Air Conditioning', iconKey: 'ac' },
  { id: 4, name: 'Laundry', iconKey: 'laundry' },
  { id: 5, name: 'Parking', iconKey: 'parking' },
  { id: 6, name: 'Security', iconKey: 'security' },
  { id: 7, name: 'Electricity Backup', iconKey: 'power-backup' },
];

const FACILITIES_URL = `${API_BASE}/facilities`;

describe('ReferenceResolver', () => {
  let resolver: ReferenceResolver;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CHAT_API_BASE_URL, useValue: API_BASE }],
    });
    resolver = TestBed.inject(ReferenceResolver);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  /**
   * The catalogue does not change during a session and three screens want it at once. One
   * request is not an optimisation here - a second one would mean the resolver had its own
   * cache instead of using the one the app already holds.
   */
  it('asks for the catalogue once however many times it is used', () => {
    const seen: number[][] = [];

    resolver.resolveFacilityNames(['wifi']).subscribe((ids) => seen.push(ids));
    resolver.resolveFacilityNames(['mess']).subscribe((ids) => seen.push(ids));
    resolver.getFacilities().subscribe();

    const request = httpMock.expectOne(FACILITIES_URL);
    expect(request.request.method).toBe('GET');
    request.flush(FACILITIES);

    // Everything after this point is answered from the held response.
    resolver.resolveFacilityNames(['ac']).subscribe((ids) => seen.push(ids));
    resolver.getFacilities().subscribe();
    httpMock.expectNone(FACILITIES_URL);

    expect(seen).toEqual([[1], [2], [3]]);
  });

  it('never goes to the network when nothing was asked for', () => {
    let result: number[] | undefined;
    resolver.resolveFacilityNames([]).subscribe((ids) => (result = ids));

    httpMock.expectNone(FACILITIES_URL);
    expect(result).toEqual([]);
  });

  it('resolves names through the cached catalogue', () => {
    let ids: number[] = [];
    resolver.resolveFacilityNames(['WIFI', 'mess', 'trampoline']).subscribe((r) => (ids = r));
    httpMock.expectOne(FACILITIES_URL).flush(FACILITIES);

    expect(ids).toEqual([1, 2]);
  });
});

describe('normaliseFacilityToken', () => {
  it('drops case and punctuation so two spellings meet', () => {
    expect(normaliseFacilityToken('Wi-Fi')).toBe('wifi');
    expect(normaliseFacilityToken('  WIFI ')).toBe('wifi');
    expect(normaliseFacilityToken('wi fi')).toBe('wifi');
    expect(normaliseFacilityToken('Electricity Backup')).toBe('electricitybackup');
    expect(normaliseFacilityToken('power-backup')).toBe('powerbackup');
  });
});

describe('matchFacilityIds', () => {
  it('matches whatever case the name arrives in', () => {
    expect(matchFacilityIds(FACILITIES, ['MESS'])).toEqual([2]);
    expect(matchFacilityIds(FACILITIES, ['mess'])).toEqual([2]);
    expect(matchFacilityIds(FACILITIES, ['  Mess  '])).toEqual([2]);
  });

  /** The seeded name is "Wi-Fi" and nobody types the hyphen. */
  it('matches a hyphenated catalogue name against the way people write it', () => {
    expect(matchFacilityIds(FACILITIES, ['wifi'])).toEqual([1]);
  });

  /** "Air Conditioning" is what the catalogue calls it; "ac" is its iconKey, and its name. */
  it('matches the short form through iconKey', () => {
    expect(matchFacilityIds(FACILITIES, ['ac'])).toEqual([3]);
    expect(matchFacilityIds(FACILITIES, ['air conditioning'])).toEqual([3]);
    expect(matchFacilityIds(FACILITIES, ['power backup'])).toEqual([7]);
  });

  it('drops a name the catalogue does not have, rather than throwing', () => {
    expect(() => matchFacilityIds(FACILITIES, ['swimming pool'])).not.toThrow();
    expect(matchFacilityIds(FACILITIES, ['swimming pool'])).toEqual([]);
  });

  it('keeps the ones it knows and drops only the ones it does not', () => {
    expect(matchFacilityIds(FACILITIES, ['wifi', 'helipad', 'mess'])).toEqual([1, 2]);
  });

  it('preserves the order they were said in', () => {
    expect(matchFacilityIds(FACILITIES, ['parking', 'wifi'])).toEqual([5, 1]);
  });

  it('does not repeat an id when two spellings mean the same facility', () => {
    expect(matchFacilityIds(FACILITIES, ['ac', 'Air Conditioning'])).toEqual([3]);
  });

  it('answers empty for an empty catalogue rather than failing', () => {
    expect(matchFacilityIds([], ['wifi'])).toEqual([]);
  });
});

describe('buildKnownFacilitiesMap', () => {
  function detail(id: number, facilities: Facility[]): PropertyDetail {
    return {
      id,
      title: `Hostel ${id}`,
      areaId: 7,
      areaName: 'Gulberg',
      cityId: 1,
      cityName: 'Lahore',
      roomType: 'Shared',
      genderPolicy: 'Boys',
      totalBeds: 10,
      availableBeds: 5,
      monthlyRent: 15000,
      securityDeposit: 20000,
      utilitiesCharge: 0,
      messCharge: 0,
      latitude: 31.5204,
      longitude: 74.3587,
      primaryThumbnailUrl: null,
      photoCount: 0,
      hasInspectionBadge: false,
      availabilityConfirmedAt: null,
      distanceKm: null,
      description: 'A room.',
      addressLine: 'Somewhere',
      houseRules: null,
      facilities,
      photos: [],
      owner: { displayName: 'Owner', identityVerified: true, identityCheckedAt: null },
      checks: [],
      createdAt: '2026-09-01T12:00:00Z',
    };
  }

  const withBoth = detail(1, [FACILITIES[0], FACILITIES[1]]);
  const withWifiOnly = detail(2, [FACILITIES[0]]);

  it('keys by property id, not by facility id', () => {
    const map = buildKnownFacilitiesMap([withBoth, withWifiOnly]);
    expect([...map.keys()]).toEqual([1, 2]);
    expect(map.get(1)).toEqual(['Wi-Fi', 'Mess']);
    expect(map.get(2)).toEqual(['Wi-Fi']);
  });

  it('is empty for no details, rather than undefined', () => {
    expect(buildKnownFacilitiesMap([]).size).toBe(0);
  });

  /**
   * The real proof of the shape: the map is handed straight to the ranker, which reads it
   * with `knownFacilities.get(card.id)`. If the key meant anything other than a property id
   * this would compile and quietly score every listing as a full match.
   */
  it('produces the shape rankProperties actually reads', () => {
    const intent: SearchIntent = {
      budgetMax: 25000,
      facilityNames: ['wifi', 'mess'],
      language: 'roman-ur',
      missingField: null,
    };
    const cards: PropertyCard[] = [withWifiOnly, withBoth];
    const known = buildKnownFacilitiesMap([withBoth, withWifiOnly]);

    const ranked = rankProperties(cards, intent, { lat: 31.5204, lng: 74.3587 }, known);

    // Identical but for facilities, so the facility signal alone decides the order.
    expect(ranked.map((r) => r.property.id)).toEqual([1, 2]);
    // .20 × (2/2) against .20 × (1/2) is a tenth of a point between them.
    expect(ranked[0].score - ranked[1].score).toBeCloseTo(0.1, 6);
  });
});
