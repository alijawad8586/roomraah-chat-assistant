import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_API_BASE_URL } from '../chat-config';

import { Page, PropertyCard } from '../models/catalog.model';
import { SearchIntent } from '../models/chat.model';
import { CandidateFetcher, buildCandidateFilters } from './candidate.fetcher';

const API_BASE = 'http://test.local/api/v1';

const PROPERTIES_URL = `${API_BASE}/properties`;

function intent(overrides: Partial<SearchIntent> = {}): SearchIntent {
  return {
    budgetMax: 25000,
    facilityNames: [],
    language: 'roman-ur',
    missingField: null,
    ...overrides,
  };
}

function card(overrides: Partial<PropertyCard> = {}): PropertyCard {
  return {
    id: 1,
    title: 'A hostel',
    areaId: 7,
    areaName: 'Gulberg',
    cityId: 1,
    cityName: 'Lahore',
    roomType: 'Shared',
    genderPolicy: 'Boys',
    totalBeds: 10,
    availableBeds: 5,
    monthlyRent: 20000,
    securityDeposit: 20000,
    utilitiesCharge: 0,
    messCharge: 0,
    latitude: 31.5204,
    longitude: 74.3587,
    primaryThumbnailUrl: null,
    photoCount: 3,
    hasInspectionBadge: false,
    availabilityConfirmedAt: null,
    distanceKm: null,
    ...overrides,
  };
}

function page(items: PropertyCard[]): Page<PropertyCard> {
  return { items, totalCount: items.length, page: 1, pageSize: 50 };
}

describe('buildCandidateFilters', () => {
  it('assembles everything it was given', () => {
    expect(buildCandidateFilters(intent({ budgetMax: 25000 }), 1, [1, 2])).toEqual({
      cityId: 1,
      maxRent: 25000,
      facilityIds: [1, 2],
      availableOnly: true,
      sort: 'Recent',
      page: 1,
      pageSize: 50,
    });
  });

  /**
   * An absent filter has to stay absent rather than become an empty one: `cityId=` is a 400,
   * and a cleared filter means "no opinion", not "match nothing".
   */
  it('leaves out a city that was never resolved', () => {
    expect(buildCandidateFilters(intent(), undefined, [1])).not.toHaveProperty('cityId');
  });

  it('leaves out a budget that was never stated', () => {
    expect(buildCandidateFilters(intent({ budgetMax: undefined }), 1)).not.toHaveProperty(
      'maxRent',
    );
  });

  it('leaves out facilities when none were named', () => {
    expect(buildCandidateFilters(intent(), 1, [])).not.toHaveProperty('facilityIds');
    expect(buildCandidateFilters(intent(), 1, undefined)).not.toHaveProperty('facilityIds');
  });

  it('always asks for available listings only', () => {
    expect(buildCandidateFilters(intent(), undefined, undefined).availableOnly).toBe(true);
  });

  /** `sort=Distance` is a 400 without a landmark, and the person's own position is not one. */
  it('sorts by Recent rather than Distance', () => {
    expect(buildCandidateFilters(intent(), 1).sort).toBe('Recent');
  });

  it('asks for the largest page the API allows', () => {
    expect(buildCandidateFilters(intent(), 1).pageSize).toBe(50);
    expect(buildCandidateFilters(intent(), 1).page).toBe(1);
  });
});

/**
 * These two arrive from a language model as free text, so the builder is the boundary where
 * "boys" becomes the enumeration member `Boys` or becomes nothing at all. Sending them
 * matters: a page is fifty listings, and spending it on the wrong gender means the ranker
 * has almost nothing left to choose between.
 */
describe('buildCandidateFilters — genderPolicy', () => {
  it('passes a valid value through in the API spelling, whatever case it arrived in', () => {
    for (const spelling of ['Boys', 'boys', 'BOYS', '  boys  ']) {
      expect(buildCandidateFilters(intent({ genderPolicy: spelling }), 1).genderPolicy).toBe(
        'Boys',
      );
    }
  });

  it('knows every member of the enumeration', () => {
    expect(buildCandidateFilters(intent({ genderPolicy: 'girls' }), 1).genderPolicy).toBe('Girls');
    expect(buildCandidateFilters(intent({ genderPolicy: 'FAMILY' }), 1).genderPolicy).toBe(
      'Family',
    );
  });

  /** A 400 helps nobody. Being misheard should widen the search, not break it. */
  it('drops a value the enumeration does not have, rather than sending it', () => {
    for (const garbled of ['male', 'larkon', 'Boyz', 'boys hostel', '']) {
      const filters = buildCandidateFilters(intent({ genderPolicy: garbled }), 1);
      expect(filters).not.toHaveProperty('genderPolicy');
    }
  });

  it('omits the filter when no preference was expressed', () => {
    expect(buildCandidateFilters(intent({ genderPolicy: null }), 1)).not.toHaveProperty(
      'genderPolicy',
    );
    expect(buildCandidateFilters(intent({ genderPolicy: undefined }), 1)).not.toHaveProperty(
      'genderPolicy',
    );
  });
});

describe('buildCandidateFilters — roomType', () => {
  it('passes a valid value through in the API spelling, whatever case it arrived in', () => {
    for (const spelling of ['Shared', 'shared', 'SHARED', ' shared ']) {
      expect(buildCandidateFilters(intent({ roomType: spelling }), 1).roomType).toBe('Shared');
    }
    expect(buildCandidateFilters(intent({ roomType: 'private' }), 1).roomType).toBe('Private');
  });

  it('drops a value the enumeration does not have', () => {
    for (const garbled of ['dorm', 'single room', 'sharing', '']) {
      expect(buildCandidateFilters(intent({ roomType: garbled }), 1)).not.toHaveProperty(
        'roomType',
      );
    }
  });

  it('omits the filter when no preference was expressed', () => {
    expect(buildCandidateFilters(intent({ roomType: undefined }), 1)).not.toHaveProperty(
      'roomType',
    );
  });
});

describe('CandidateFetcher', () => {
  let fetcher: CandidateFetcher;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CHAT_API_BASE_URL, useValue: API_BASE }],
    });
    fetcher = TestBed.inject(CandidateFetcher);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('sends every filter as a query parameter', () => {
    fetcher.fetchCandidates(intent({ budgetMax: 25000 }), 1, [1, 2]).subscribe();

    const request = httpMock.expectOne((r) => r.url === PROPERTIES_URL);
    expect(request.request.method).toBe('GET');

    const params = request.request.params;
    expect(params.get('cityId')).toBe('1');
    expect(params.get('maxRent')).toBe('25000');
    expect(params.get('facilityIds')).toBe('1,2');
    expect(params.get('availableOnly')).toBe('true');
    expect(params.get('sort')).toBe('Recent');
    expect(params.get('page')).toBe('1');
    expect(params.get('pageSize')).toBe('50');

    request.flush(page([]));
  });

  it('narrows the page by gender and room type on the server', () => {
    fetcher
      .fetchCandidates(intent({ genderPolicy: 'boys', roomType: 'shared' }), 1)
      .subscribe();

    const request = httpMock.expectOne((r) => r.url === PROPERTIES_URL);
    expect(request.request.params.get('genderPolicy')).toBe('Boys');
    expect(request.request.params.get('roomType')).toBe('Shared');

    request.flush(page([]));
  });

  it('sends no gender parameter when the model returned something invalid', () => {
    fetcher.fetchCandidates(intent({ genderPolicy: 'larkon' }), 1).subscribe();

    const request = httpMock.expectOne((r) => r.url === PROPERTIES_URL);
    expect(request.request.params.has('genderPolicy')).toBe(false);

    request.flush(page([]));
  });

  it('omits the parameters it has no value for', () => {
    fetcher.fetchCandidates(intent({ budgetMax: undefined })).subscribe();

    const request = httpMock.expectOne((r) => r.url === PROPERTIES_URL);
    expect(request.request.params.has('cityId')).toBe(false);
    expect(request.request.params.has('maxRent')).toBe(false);
    expect(request.request.params.has('facilityIds')).toBe(false);
    // The ones that are never negotiable are still there.
    expect(request.request.params.get('availableOnly')).toBe('true');
    expect(request.request.params.get('pageSize')).toBe('50');

    request.flush(page([]));
  });

  it('unwraps the page envelope and answers with the items', () => {
    let received: PropertyCard[] | undefined;
    fetcher.fetchCandidates(intent(), 1).subscribe((items) => (received = items));

    const items = [card({ id: 1 }), card({ id: 2 })];
    httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page(items));

    expect(received?.map((c) => c.id)).toEqual([1, 2]);
  });

  it('answers with an empty list when the search found nothing', () => {
    let received: PropertyCard[] | undefined;
    fetcher.fetchCandidates(intent(), 1).subscribe((items) => (received = items));

    httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([]));

    expect(received).toEqual([]);
  });

  /**
   * The server filters `maxRent` against `monthlyRent` alone, so this listing is inside the
   * 25,000 ceiling on rent and over it once utilities and mess are counted. The fetcher must
   * hand it on regardless: dropping it here would apply the total-cost rule twice, and the
   * ranker is the only place that knows whether mess was asked for.
   */
  it('does not second-guess the total cost - that is the ranker', () => {
    let received: PropertyCard[] | undefined;
    fetcher.fetchCandidates(intent({ budgetMax: 25000 }), 1).subscribe((items) => {
      received = items;
    });

    const overOnceCharged = card({ id: 9, monthlyRent: 24000, utilitiesCharge: 3000 });
    httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([overOnceCharged]));

    expect(received?.map((c) => c.id)).toEqual([9]);
  });

  it('makes exactly one request per search', () => {
    fetcher.fetchCandidates(intent(), 1).subscribe();
    httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([]));
    httpMock.expectNone((r) => r.url === PROPERTIES_URL);
  });
});
