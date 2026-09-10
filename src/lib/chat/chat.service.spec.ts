import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injectable, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_API_BASE_URL } from '../chat-config';

import {
  City,
  Facility,
  Page,
  PropertyCard,
  PropertyDetail,
  ReviewPage,
} from '../models/catalog.model';
import { ChatMessage } from '../models/chat.model';
import { Coords, GeolocationService, GeolocationState } from '../services/geolocation.service';
import {
  ChatService,
  ComposeRequest,
  FALLBACK_DETAIL_FETCH_POOL_SIZE,
  FOLLOW_UP_QUESTION,
} from './chat.service';

const API_BASE = 'http://test.local/api/v1';

const BASE = API_BASE;
const PARSE_URL = `${BASE}/ai/parse`;
const COMPOSE_URL = `${BASE}/ai/compose`;
const CITIES_URL = `${BASE}/locations/cities`;
const FACILITIES_URL = `${BASE}/facilities`;
const PROPERTIES_URL = `${BASE}/properties`;

const LAHORE: Coords = { lat: 31.5204, lng: 74.3587 };

const CITIES: City[] = [
  { id: 3, name: 'Islamabad' },
  { id: 2, name: 'Karachi' },
  { id: 1, name: 'Lahore' },
];

/** The live catalogue, as `GET /api/v1/facilities` really answers. */
const FACILITIES: Facility[] = [
  { id: 1, name: 'Wi-Fi', iconKey: 'wifi' },
  { id: 2, name: 'Mess', iconKey: 'mess' },
];

/** Contract §3.4 example A, with a budget so no follow-up is asked. */
const PARSED_WITH_BUDGET = {
  budgetMax: 25000,
  nearMe: true,
  cityName: null,
  areaName: null,
  landmarkName: null,
  genderPolicy: 'Boys',
  facilityNames: ['wifi'],
  roomType: null,
  language: 'roman-ur',
  missingField: null,
};

/** Contract §3.4 example B - no budget, the one follow-up. */
const PARSED_NO_BUDGET = {
  budgetMax: null,
  nearMe: true,
  cityName: null,
  areaName: null,
  landmarkName: null,
  genderPolicy: 'Boys',
  facilityNames: [],
  roomType: null,
  language: 'roman-ur',
  missingField: 'budget',
};

function card(overrides: Partial<PropertyCard> = {}): PropertyCard {
  return {
    id: 1,
    title: 'Al-Madina Boys Hostel',
    areaId: 7,
    areaName: 'Gulberg',
    cityId: 1,
    cityName: 'Lahore',
    roomType: 'Shared',
    genderPolicy: 'Boys',
    totalBeds: 8,
    availableBeds: 3,
    monthlyRent: 20000,
    securityDeposit: 20000,
    utilitiesCharge: 0,
    messCharge: 0,
    latitude: LAHORE.lat,
    longitude: LAHORE.lng,
    primaryThumbnailUrl: null,
    photoCount: 4,
    hasInspectionBadge: false,
    availabilityConfirmedAt: null,
    distanceKm: null,
    ...overrides,
  };
}

function detail(id: number, facilities: Facility[]): PropertyDetail {
  return {
    ...card({ id }),
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

function page(items: PropertyCard[]): Page<PropertyCard> {
  return { items, totalCount: items.length, page: 1, pageSize: 50 };
}

function reviewPage(averageRating: number): ReviewPage {
  return { items: [], totalCount: 0, page: 1, pageSize: 1, averageRating };
}

@Injectable()
class FakeGeolocationService {
  readonly position = signal<Coords | null>(null);
  readonly state = signal<GeolocationState>('idle');
  readonly hasPosition = computed(() => this.position() !== null);
  readonly request = vi.fn<() => void>(() => this.state.set('asking'));
  readonly forget = vi.fn<() => void>();

  grant(coords: Coords): void {
    this.position.set(coords);
    this.state.set('granted');
  }

  deny(): void {
    this.position.set(null);
    this.state.set('denied');
  }
}

describe('ChatService', () => {
  let chat: ChatService;
  let httpMock: HttpTestingController;
  let geo: FakeGeolocationService;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

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
    chat = TestBed.inject(ChatService);
    httpMock = TestBed.inject(HttpTestingController);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    httpMock.verify();
    warn.mockRestore();
    error.mockRestore();
  });

  /** The search half of the flow, which most tests need to walk through identically. */
  function flushSearch(candidates: PropertyCard[]) {
    httpMock.expectOne(CITIES_URL).flush(CITIES);
    httpMock.expectOne(FACILITIES_URL).flush(FACILITIES);
    httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page(candidates));
  }

  describe('the happy path', () => {
    it('walks parse → locate → search → rank → enrich → compose', () => {
      geo.grant(LAHORE);
      let reply: ChatMessage | undefined;
      chat.handleUserMessage('25k tak boys hostel wifi ke sath').subscribe((m) => (reply = m));

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      flushSearch([card({ id: 1 }), card({ id: 2, monthlyRent: 22000 })]);

      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`).flush(reviewPage(4.2));
      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/2/reviews`).flush(reviewPage(3.8));

      const compose = httpMock.expectOne(COMPOSE_URL);
      compose.flush({ reply: 'Al-Madina Boys Hostel — Rs. 20,000/month' });

      expect(reply?.role).toBe('assistant');
      expect(reply?.text).toContain('Al-Madina');
    });

    it('sends the compose payload the contract describes', () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      flushSearch([card({ id: 1 })]);
      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`).flush(reviewPage(4.2));

      const compose = httpMock.expectOne(COMPOSE_URL);
      const body = compose.request.body as ComposeRequest;

      expect(compose.request.method).toBe('POST');
      expect(body.language).toBe('roman-ur');
      expect(body.mode).toBe('normal');
      expect(body.hostels).toHaveLength(1);
      expect(body.hostels[0].id).toBe(1);
      expect(body.hostels[0].averageRating).toBe(4.2);
      // Contract §2.2.1: the distance in a compose payload is measured from the person.
      expect(body.hostels[0].distanceKm).toBeCloseTo(0, 6);

      compose.flush({ reply: 'ok' });
    });

    it('sends at most five hostels', () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      flushSearch([1, 2, 3, 4, 5, 6, 7].map((id) => card({ id })));

      for (const id of [1, 2, 3, 4, 5]) {
        httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/${id}/reviews`).flush(reviewPage(4));
      }
      httpMock.expectNone((r) => r.url === `${PROPERTIES_URL}/6/reviews`);

      const compose = httpMock.expectOne(COMPOSE_URL);
      expect((compose.request.body as ComposeRequest).hostels).toHaveLength(5);
      compose.flush({ reply: 'ok' });
    });

    /** A listing with no reviews contributes null, so §4.3 C2 writes "maloom nahi" for it. */
    it('carries a missing rating through as null rather than zero', () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      flushSearch([card({ id: 1 })]);
      httpMock
        .expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`)
        .flush({ error: 'none' }, { status: 404, statusText: 'Not Found' });

      const compose = httpMock.expectOne(COMPOSE_URL);
      expect((compose.request.body as ComposeRequest).hostels[0].averageRating).toBeNull();
      compose.flush({ reply: 'ok' });
    });
  });

  describe('the follow-up short circuit', () => {
    it('asks for the budget and stops', () => {
      let reply: ChatMessage | undefined;
      chat.handleUserMessage('mere near koi boys hostel hai?').subscribe((m) => (reply = m));

      httpMock.expectOne(PARSE_URL).flush(PARSED_NO_BUDGET);

      expect(reply?.text).toBe(FOLLOW_UP_QUESTION);
      // Nothing else was touched: no location, no search, no compose.
      httpMock.expectNone(CITIES_URL);
      httpMock.expectNone(FACILITIES_URL);
      httpMock.expectNone((r) => r.url === PROPERTIES_URL);
      httpMock.expectNone(COMPOSE_URL);
    });
  });

  describe('parse failures', () => {
    function replyForStatus(status: number): string {
      let reply: ChatMessage | undefined;
      chat.handleUserMessage('...').subscribe((m) => (reply = m));
      httpMock
        .expectOne(PARSE_URL)
        .flush({ error: 'x' }, { status, statusText: 'error' });
      return reply?.text ?? '';
    }

    it('never falls through to the follow-up question', () => {
      expect(replyForStatus(502)).not.toBe(FOLLOW_UP_QUESTION);
    });

    it('gives 400 its own wording', () => {
      expect(replyForStatus(400)).toContain('samajh nahi paya');
    });

    it('gives 429 its own wording, which invites a retry', () => {
      expect(replyForStatus(429)).toContain('Ek lamha');
    });

    it('treats 502 and 504 as the service being unavailable', () => {
      expect(replyForStatus(502)).toContain('dastyab nahi');
      expect(replyForStatus(504)).toContain('dastyab nahi');
    });

    it('produces three distinct messages across the four statuses', () => {
      const texts = [400, 429, 502, 504].map(replyForStatus);
      expect(new Set(texts).size).toBe(3); // 502 and 504 share wording by design
      expect(texts[2]).toBe(texts[3]);
    });

    it('still records the turn in the history', () => {
      replyForStatus(502);
      expect(chat.getHistory()).toHaveLength(2);
      expect(chat.getHistory()[1].role).toBe('assistant');
    });
  });

  describe('compose failures', () => {
    function failComposeWith(status: number): string {
      geo.grant(LAHORE);
      let reply: ChatMessage | undefined;
      chat.handleUserMessage('...').subscribe((m) => (reply = m));

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      flushSearch([card({ id: 1 })]);
      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`).flush(reviewPage(4));
      httpMock.expectOne(COMPOSE_URL).flush({ error: 'x' }, { status, statusText: 'error' });

      return reply?.text ?? '';
    }

    /**
     * §4.5 disagrees with §3.5 here: a compose 400 is a defect in this frontend's payload,
     * not the person's message, so it is logged and shown as a generic failure.
     */
    it('treats a 400 as a frontend defect, logged, not as "I did not understand"', () => {
      const text = failComposeWith(400);
      expect(text).toContain('kuch ghalat ho gaya');
      expect(text).not.toContain('samajh nahi paya');
      expect(error).toHaveBeenCalledTimes(1);
    });

    // One search per test: `ReferenceService` holds the cities and facilities lists for the
    // session, so a second search inside the same test would not re-request them and the
    // shared helper above would be waiting for a call that is never made.
    it('shares the 429 wording with parse', () => {
      expect(failComposeWith(429)).toContain('Ek lamha');
    });

    it('shares the unavailable wording with parse', () => {
      expect(failComposeWith(502)).toContain('dastyab nahi');
    });

    it('treats an empty reply as the service failing', () => {
      geo.grant(LAHORE);
      let reply: ChatMessage | undefined;
      chat.handleUserMessage('...').subscribe((m) => (reply = m));

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      flushSearch([card({ id: 1 })]);
      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`).flush(reviewPage(4));
      httpMock.expectOne(COMPOSE_URL).flush({ reply: '   ' });

      expect(reply?.text).toContain('dastyab nahi');
    });
  });

  describe('the loosened retry', () => {
    /** Inside the ceiling on rent alone is not inside it once everything is counted. */
    const tooExpensive = card({ id: 1, monthlyRent: 28000 });

    it('searches a second time, without facilities and with a wider budget', () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      httpMock.expectOne(CITIES_URL).flush(CITIES);
      httpMock.expectOne(FACILITIES_URL).flush(FACILITIES);

      const first = httpMock.expectOne((r) => r.url === PROPERTIES_URL);
      expect(first.request.params.get('maxRent')).toBe('25000');
      expect(first.request.params.get('facilityIds')).toBe('1');
      first.flush(page([tooExpensive]));

      // Nothing survived the budget, so a second search goes out - looser, and only once.
      const second = httpMock.expectOne((r) => r.url === PROPERTIES_URL);
      expect(second.request.params.get('maxRent')).toBe('30000');
      expect(second.request.params.has('facilityIds')).toBe(false);
      second.flush(page([tooExpensive]));

      // The retry filtered nothing on facilities, so the ranker is given the real map.
      httpMock.expectOne(`${PROPERTIES_URL}/1`).flush(detail(1, [FACILITIES[0]]));
      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`).flush(reviewPage(4));

      const compose = httpMock.expectOne(COMPOSE_URL);
      expect((compose.request.body as ComposeRequest).mode).toBe('fallback');
      compose.flush({ reply: 'Exact match nahi mila, yeh qareeb tareen hain.' });
    });

    /**
     * The detail fetch is the expensive part of the fallback path - one request per listing -
     * so the pool it runs over is capped. Pinned here because the cap is a tuning decision
     * and a change to it should be a deliberate one, not a silent regression.
     */
    it(`fetches details for at most ${FALLBACK_DETAIL_FETCH_POOL_SIZE} candidates`, () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();

      // Identical but for id, so ranking ties break by id and the pool is ids 1..8.
      const many = Array.from({ length: 12 }, (_, i) => card({ id: i + 1, monthlyRent: 28000 }));

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      httpMock.expectOne(CITIES_URL).flush(CITIES);
      httpMock.expectOne(FACILITIES_URL).flush(FACILITIES);
      httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page(many));
      httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page(many));

      for (let id = 1; id <= FALLBACK_DETAIL_FETCH_POOL_SIZE; id++) {
        httpMock.expectOne(`${PROPERTIES_URL}/${id}`).flush(detail(id, [FACILITIES[0]]));
      }
      httpMock.expectNone(`${PROPERTIES_URL}/${FALLBACK_DETAIL_FETCH_POOL_SIZE + 1}`);

      // Reviews are still only fetched for the five that are actually shown.
      for (const id of [1, 2, 3, 4, 5]) {
        httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/${id}/reviews`).flush(reviewPage(4));
      }
      httpMock.expectNone((r) => r.url === `${PROPERTIES_URL}/6/reviews`);

      httpMock.expectOne(COMPOSE_URL).flush({ reply: 'ok' });
    });

    it('does not mutate the original intent when it widens the budget', () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      httpMock.expectOne(CITIES_URL).flush(CITIES);
      httpMock.expectOne(FACILITIES_URL).flush(FACILITIES);
      httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([tooExpensive]));
      httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([]));

      // The parsed body the backend sent is untouched - 25000, not 30000.
      expect(PARSED_WITH_BUDGET.budgetMax).toBe(25000);
    });

    it('gives up after one retry and never calls compose', () => {
      geo.grant(LAHORE);
      let reply: ChatMessage | undefined;
      chat.handleUserMessage('...').subscribe((m) => (reply = m));

      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);
      httpMock.expectOne(CITIES_URL).flush(CITIES);
      httpMock.expectOne(FACILITIES_URL).flush(FACILITIES);
      httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([]));
      httpMock.expectOne((r) => r.url === PROPERTIES_URL).flush(page([]));

      // No third search, no details, no reviews, and above all no compose.
      httpMock.expectNone((r) => r.url === PROPERTIES_URL);
      httpMock.expectNone(COMPOSE_URL);

      expect(reply?.text).toContain('koi hostel nahi mila');
    });
  });

  describe('getHistory', () => {
    it('starts empty', () => {
      expect(chat.getHistory()).toEqual([]);
    });

    it('accumulates both turns, in order', () => {
      chat.handleUserMessage('pehla sawaal').subscribe();
      httpMock.expectOne(PARSE_URL).flush(PARSED_NO_BUDGET);

      chat.handleUserMessage('doosra sawaal').subscribe();
      httpMock.expectOne(PARSE_URL).flush(PARSED_NO_BUDGET);

      const history = chat.getHistory();
      expect(history).toHaveLength(4);
      expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(history[0].text).toBe('pehla sawaal');
      expect(history[1].text).toBe(FOLLOW_UP_QUESTION);
      expect(history[2].text).toBe('doosra sawaal');
    });

    it('hands back a copy a caller cannot write into', () => {
      chat.handleUserMessage('...').subscribe();
      httpMock.expectOne(PARSE_URL).flush(PARSED_NO_BUDGET);

      chat.getHistory().push({ role: 'user', text: 'injected', timestamp: 0 });
      expect(chat.getHistory()).toHaveLength(2);
    });

    it('records nothing until the turn has an answer', () => {
      geo.grant(LAHORE);
      chat.handleUserMessage('...').subscribe();
      httpMock.expectOne(PARSE_URL).flush(PARSED_WITH_BUDGET);

      // Mid-flight: the search has not come back yet.
      expect(chat.getHistory()).toEqual([]);

      flushSearch([card({ id: 1 })]);
      httpMock.expectOne((r) => r.url === `${PROPERTIES_URL}/1/reviews`).flush(reviewPage(4));
      httpMock.expectOne(COMPOSE_URL).flush({ reply: 'done' });

      expect(chat.getHistory()).toHaveLength(2);
    });
  });
});
