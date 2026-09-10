import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_API_BASE_URL } from '../chat-config';

import { SearchIntent } from '../models/chat.model';
import {
  IntentParser,
  needsFollowUp,
  normaliseIntent,
  safeDefaultIntent,
} from './intent.parser';

const API_BASE = 'http://test.local/api/v1';

/**
 * The backend for this endpoint does not exist yet - it is being written in another
 * repository against `AI_ENDPOINTS_CONTRACT.md`. Every payload below is copied from that
 * document's own worked examples (§3.4) rather than imagined, so if the backend is built to
 * the document these tests describe what will actually arrive. The malformed cases are the
 * other half of the same bet: what this module must do when the document is not honoured.
 */

const PARSE_URL = `${API_BASE}/ai/parse`;

/** Contract §3.4 example A - everything present, budget extracted. */
const EXAMPLE_A = {
  budgetMax: 25000,
  nearMe: true,
  cityName: null,
  areaName: null,
  landmarkName: null,
  genderPolicy: 'Boys',
  facilityNames: ['wifi', 'mess'],
  roomType: null,
  language: 'roman-ur',
  missingField: null,
};

/** Contract §3.4 example B - no budget, the one follow-up. */
const EXAMPLE_B = {
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

/** Contract §3.4 example C - English, landmark named, no gender, still no follow-up. */
const EXAMPLE_C = {
  budgetMax: 18000,
  nearMe: false,
  cityName: null,
  areaName: null,
  landmarkName: 'Punjab University',
  genderPolicy: null,
  facilityNames: [],
  roomType: null,
  language: 'en',
  missingField: null,
};

describe('IntentParser', () => {
  let parser: IntentParser;
  let httpMock: HttpTestingController;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CHAT_API_BASE_URL, useValue: API_BASE }],
    });
    parser = TestBed.inject(IntentParser);
    httpMock = TestBed.inject(HttpTestingController);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    httpMock.verify();
    warn.mockRestore();
  });

  describe('the request', () => {
    /** Contract §1: same base URL and `/api/v1` prefix as every other endpoint. */
    it('posts the text to /ai/parse under the shared api base', () => {
      parser.parseUserMessage('mere nazdeek hostel').subscribe();

      const request = httpMock.expectOne(PARSE_URL);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ text: 'mere nazdeek hostel' });

      request.flush(EXAMPLE_B);
    });

    it('needs no separate AI host', () => {
      expect(PARSE_URL).toBe('http://52.72.119.254:8080/api/v1/ai/parse');
    });
  });

  describe('a well-formed response', () => {
    it('reads contract example A', () => {
      let intent: SearchIntent | undefined;
      parser.parseUserMessage('...').subscribe((i) => (intent = i));
      httpMock.expectOne(PARSE_URL).flush(EXAMPLE_A);

      expect(intent).toEqual({
        budgetMax: 25000,
        nearMe: true,
        genderPolicy: 'Boys',
        facilityNames: ['wifi', 'mess'],
        language: 'roman-ur',
        missingField: null,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    /**
     * The contract's examples send `null` for optional fields; `chat.model.ts` types them as
     * optional. Normalising here means no consumer has to handle both spellings of absent.
     */
    it('turns the nulls the contract sends into absent keys', () => {
      let intent: SearchIntent | undefined;
      parser.parseUserMessage('...').subscribe((i) => (intent = i));
      httpMock.expectOne(PARSE_URL).flush(EXAMPLE_A);

      expect(intent).not.toHaveProperty('cityName');
      expect(intent).not.toHaveProperty('areaName');
      expect(intent).not.toHaveProperty('landmarkName');
      expect(intent).not.toHaveProperty('roomType');
    });

    it('reads contract example B, the budget follow-up', () => {
      let intent: SearchIntent | undefined;
      parser.parseUserMessage('...').subscribe((i) => (intent = i));
      httpMock.expectOne(PARSE_URL).flush(EXAMPLE_B);

      expect(intent?.missingField).toBe('budget');
      expect(intent).not.toHaveProperty('budgetMax');
      expect(intent?.facilityNames).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads contract example C, English with a landmark', () => {
      let intent: SearchIntent | undefined;
      parser.parseUserMessage('...').subscribe((i) => (intent = i));
      httpMock.expectOne(PARSE_URL).flush(EXAMPLE_C);

      expect(intent).toEqual({
        budgetMax: 18000,
        nearMe: false,
        landmarkName: 'Punjab University',
        genderPolicy: null,
        facilityNames: [],
        language: 'en',
        missingField: null,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('copies facilityNames rather than holding the response array', () => {
      let intent: SearchIntent | undefined;
      parser.parseUserMessage('...').subscribe((i) => (intent = i));
      const body = { ...EXAMPLE_A, facilityNames: ['wifi'] };
      httpMock.expectOne(PARSE_URL).flush(body);

      intent?.facilityNames.push('mess');
      expect(body.facilityNames).toEqual(['wifi']);
    });
  });

  describe('a malformed response falls back rather than throwing', () => {
    function expectSafeDefault(body: unknown) {
      let intent: SearchIntent | undefined;
      let errored = false;
      parser.parseUserMessage('...').subscribe({
        next: (i) => (intent = i),
        error: () => (errored = true),
      });
      httpMock.expectOne(PARSE_URL).flush(body as object);

      expect(errored).toBe(false);
      expect(intent).toEqual(safeDefaultIntent());
      expect(intent?.missingField).toBe('budget');
      return intent;
    }

    it('falls back when facilityNames is missing', () => {
      expectSafeDefault({ language: 'roman-ur', missingField: 'budget' });
    });

    it('falls back when facilityNames is null instead of an empty array', () => {
      expectSafeDefault({ ...EXAMPLE_B, facilityNames: null });
    });

    it('falls back when facilityNames holds something that is not a string', () => {
      expectSafeDefault({ ...EXAMPLE_B, facilityNames: ['wifi', 7] });
    });

    it('falls back on a language outside the two the contract allows', () => {
      expectSafeDefault({ ...EXAMPLE_B, language: 'ur' });
    });

    it('falls back when missingField is absent entirely', () => {
      const { missingField: _dropped, ...withoutMissingField } = EXAMPLE_B;
      expectSafeDefault(withoutMissingField);
    });

    /**
     * §3.3 R1 is a biconditional: `missingField: null` claims a budget was extracted, so a
     * body that claims it without a usable `budgetMax` contradicts itself. Asking for the
     * budget is both the safe reading and the useful one.
     */
    it('falls back when the body claims a budget it did not send', () => {
      expectSafeDefault({ ...EXAMPLE_A, budgetMax: null, missingField: null });
    });

    it('falls back when budgetMax arrives as a string', () => {
      expectSafeDefault({ ...EXAMPLE_A, budgetMax: '25000' });
    });

    it('falls back when the body is not an object at all', () => {
      expectSafeDefault('sorry, I could not parse that');
    });

    it('falls back when the body is an array', () => {
      expectSafeDefault([EXAMPLE_A]);
    });

    it('logs the offending body so the contract breach is visible', () => {
      parser.parseUserMessage('...').subscribe();
      httpMock.expectOne(PARSE_URL).flush({ nonsense: true });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('/ai/parse');
    });

    it('hands back a fresh default each time, not a shared one', () => {
      const first = safeDefaultIntent();
      first.facilityNames.push('wifi');
      expect(safeDefaultIntent().facilityNames).toEqual([]);
    });
  });

  /**
   * Contract §3.5 gives each status its own wording on screen. Absorbing them into a budget
   * question would tell the person the service is working when it is not, so they propagate
   * and the orchestrator decides what to say.
   */
  describe('an HTTP failure propagates', () => {
    for (const status of [400, 429, 502, 504]) {
      it(`does not disguise a ${status} as a parsed intent`, () => {
        let intent: SearchIntent | undefined;
        let errorStatus: number | undefined;
        parser.parseUserMessage('...').subscribe({
          next: (i) => (intent = i),
          error: (e: { status: number }) => (errorStatus = e.status),
        });

        httpMock
          .expectOne(PARSE_URL)
          .flush({ error: 'nope' }, { status, statusText: 'error' });

        expect(intent).toBeUndefined();
        expect(errorStatus).toBe(status);
      });
    }
  });
});

describe('normaliseIntent', () => {
  it('accepts the minimum the contract guarantees', () => {
    expect(
      normaliseIntent({ facilityNames: [], language: 'en', missingField: 'budget' }),
    ).toEqual({ facilityNames: [], language: 'en', missingField: 'budget' });
  });

  it('rejects anything that is not a SearchIntent', () => {
    expect(normaliseIntent(null)).toBeNull();
    expect(normaliseIntent(undefined)).toBeNull();
    expect(normaliseIntent(42)).toBeNull();
    expect(normaliseIntent('text')).toBeNull();
    expect(normaliseIntent([])).toBeNull();
    expect(normaliseIntent({})).toBeNull();
  });

  it('keeps an explicit null genderPolicy, which the type allows', () => {
    const intent = normaliseIntent({ ...EXAMPLE_C, genderPolicy: null });
    expect(intent?.genderPolicy).toBeNull();
  });

  /** §2.1.1: the backend must not normalise these, and neither does this. */
  it('passes an unrecognised genderPolicy through untouched', () => {
    const intent = normaliseIntent({ ...EXAMPLE_C, genderPolicy: 'larkon' });
    expect(intent?.genderPolicy).toBe('larkon');
  });
});

describe('needsFollowUp', () => {
  function intent(missingField: string | null): SearchIntent {
    return { facilityNames: [], language: 'roman-ur', missingField };
  }

  it('is true for the one question the chatbot has wording for', () => {
    expect(needsFollowUp(intent('budget'))).toBe(true);
  });

  it('is false when nothing is missing', () => {
    expect(needsFollowUp(intent(null))).toBe(false);
  });

  /**
   * R1 forbids any other value. If one arrives anyway, searching a little too widely beats
   * inventing a question out of a string the chatbot was handed.
   */
  it('is false for any other value, rather than asking an invented question', () => {
    expect(needsFollowUp(intent('city'))).toBe(false);
    expect(needsFollowUp(intent('gender'))).toBe(false);
    expect(needsFollowUp(intent(''))).toBe(false);
    expect(needsFollowUp(intent('Budget'))).toBe(false);
  });

  it('is exposed on the service too', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CHAT_API_BASE_URL, useValue: API_BASE }],
    });
    const parser = TestBed.inject(IntentParser);
    expect(parser.needsFollowUp(intent('budget'))).toBe(true);
    expect(parser.needsFollowUp(intent(null))).toBe(false);
  });
});
