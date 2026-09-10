/**
 * One typed message turned into a `SearchIntent`.
 *
 * Built against `AI_ENDPOINTS_CONTRACT.md` §3, which is the agreement with the backend
 * developer implementing `POST /api/v1/ai/parse` in a separate repository. That endpoint does
 * not exist yet, so nothing here may assume it behaves - every response is checked before it
 * is believed, and a response that is not a `SearchIntent` degrades into asking the person
 * their budget rather than into a broken chatbot.
 *
 * This is the only module in the chat feature that talks to a language model, and it does so
 * at arm's length: it sends text and receives a shape. It does no searching, holds no
 * conversation state, and never sees a listing.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map, timeout } from 'rxjs/operators';
import { CHAT_API_BASE_URL } from '../chat-config';
import { SearchIntent } from '../models/chat.model';

/**
 * Contract §7: "Frontend LLM timeout - 30 s, against a recommended 10 s server-side timeout."
 * The margin is deliberate; if the server is doing its job this never fires.
 */
export const PARSE_TIMEOUT_MS = 30_000;

/** Contract §3.1. Longer than this is a documented 400, so it is worth not sending. */
export const PARSE_TEXT_MAX_LENGTH = 2000;

@Injectable({ providedIn: 'root' })
export class IntentParser {
  private readonly http = inject(HttpClient);

  /**
   * Contract §1: both AI endpoints sit under the same base URL and `/api/v1` prefix as every
   * other endpoint, which is why there is no separate AI host here and why `authInterceptor`
   * needs no change - it already attaches a token to anything starting with `apiBaseUrl`.
   */
  private readonly base = inject(CHAT_API_BASE_URL);

  /**
   * Sends the message and answers with something that is definitely a `SearchIntent`.
   *
   * A malformed body is not an error to the caller. Contract §3.5 forbids the backend from
   * inventing an intent when the model fails - it must answer with a status - so a 200 whose
   * body is not an intent means the contract was broken, and the least harmful reading of a
   * broken contract is "I did not understand, what is your budget?". That is what the safe
   * default says.
   *
   * HTTP failures are *not* absorbed. They propagate, because §3.5 gives each status its own
   * wording - 400 "I didn't catch that", 429 "one moment", 502/504 service unavailable - and
   * swallowing them into a budget question would tell the person the service is working when
   * it is not.
   */
  parseUserMessage(text: string): Observable<SearchIntent> {
    return this.http.post<unknown>(`${this.base}/ai/parse`, { text }).pipe(
      timeout(PARSE_TIMEOUT_MS),
      map((body) => {
        const intent = normaliseIntent(body);
        if (intent) return intent;

        // Logged rather than swallowed silently: this branch means the deployed backend is
        // not honouring §3.2, which is a defect somebody needs to see.
        console.warn(
          '[chat] POST /ai/parse answered 200 with a body that is not a SearchIntent. ' +
            'Falling back to asking for the budget. See AI_ENDPOINTS_CONTRACT.md §3.2.',
          body,
        );
        return safeDefaultIntent();
      }),
    );
  }

  /** Contract §3.3 R1: the one question worth interrupting for, and the only one. */
  needsFollowUp(intent: SearchIntent): boolean {
    return needsFollowUp(intent);
  }
}

/**
 * True only for `"budget"`.
 *
 * R1 makes `missingField` a biconditional with the budget and forbids every other value, so
 * anything else that arrives - a backend that decided a missing city was worth asking about -
 * is read as "no question", not as an unknown question. The chatbot has wording for exactly
 * one follow-up; inventing a second from a string it was handed would be worse than searching
 * a little too widely.
 */
export function needsFollowUp(intent: SearchIntent): boolean {
  return intent.missingField === 'budget';
}

/**
 * What the chatbot falls back to when the response cannot be trusted.
 *
 * A fresh object each call rather than a frozen constant: callers hold intents and the
 * ranker reads `facilityNames`, and a shared array that one caller emptied would quietly
 * change another's search.
 *
 * `roman-ur` because a malformed response tells us nothing about the language the person
 * wrote in, and Roman Urdu is the common case for RoomRaah.
 */
export function safeDefaultIntent(): SearchIntent {
  return {
    facilityNames: [],
    language: 'roman-ur',
    missingField: 'budget',
  };
}

/**
 * Checks a response body against `SearchIntent` and cleans it, or answers null.
 *
 * Two jobs beyond type-checking. First, the contract's examples (§3.4) send `null` for
 * optional fields rather than omitting them, while `chat.model.ts` types them as optional -
 * so a `null` is normalised to an absent key, and every consumer's `!= null` test keeps
 * working without each one having to know.
 *
 * Second, it enforces R1's load-bearing direction: `missingField: null` means a budget was
 * extracted, so a body claiming that without a usable `budgetMax` contradicts itself. That is
 * treated as malformed, and the safe default asks for the budget - which is what the person
 * needed anyway.
 */
export function normaliseIntent(value: unknown): SearchIntent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  // §3.3 R3 - these three are always present, whatever else is missing.
  const facilityNames = raw['facilityNames'];
  if (!Array.isArray(facilityNames) || !facilityNames.every((n) => typeof n === 'string')) {
    return null;
  }

  const language = raw['language'];
  if (language !== 'roman-ur' && language !== 'en') return null;

  if (!('missingField' in raw)) return null;
  const missingField = raw['missingField'];
  if (missingField !== null && typeof missingField !== 'string') return null;

  const intent: SearchIntent = {
    facilityNames: [...facilityNames],
    language,
    missingField,
  };

  const budgetMax = asNumber(raw['budgetMax']);
  if (budgetMax !== undefined) intent.budgetMax = budgetMax;

  // R1, the direction that matters: a claim that the budget was understood, with no budget.
  if (missingField === null && budgetMax === undefined) return null;

  const nearMe = asBoolean(raw['nearMe']);
  if (nearMe !== undefined) intent.nearMe = nearMe;

  const cityName = asString(raw['cityName']);
  if (cityName !== undefined) intent.cityName = cityName;

  const areaName = asString(raw['areaName']);
  if (areaName !== undefined) intent.areaName = areaName;

  const landmarkName = asString(raw['landmarkName']);
  if (landmarkName !== undefined) intent.landmarkName = landmarkName;

  const roomType = asString(raw['roomType']);
  if (roomType !== undefined) intent.roomType = roomType;

  // The one optional the model is allowed to answer `null` for explicitly - the type admits
  // it - so an actual null is carried through rather than dropped.
  const genderPolicy = raw['genderPolicy'];
  if (typeof genderPolicy === 'string') intent.genderPolicy = genderPolicy;
  else if (genderPolicy === null) intent.genderPolicy = null;

  return intent;
}

/** A wrong type is dropped rather than coerced: "25000" is not a budget, it is a bug. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
