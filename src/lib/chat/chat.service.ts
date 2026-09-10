/**
 * The chatbot's orchestrator: one typed message in, one composed reply out.
 *
 * Every step is somebody else's job. This file only decides the order, what to do when a
 * step comes back empty, and what to say when one fails. It holds the conversation and
 * nothing else - no parsing, no scoring, no HTTP beyond the one compose call that has no
 * home anywhere else.
 *
 *   parse → locate + resolve facilities → search → rank → (retry loosened) → enrich → compose
 *
 * `/ai/parse` and `/ai/compose` do not exist yet; they are being built in another repository
 * against `AI_ENDPOINTS_CONTRACT.md`. Nothing here assumes they work, and the error wording
 * below follows that document's §3.5 and §4.5 tables, which differ - see `wordingFor`.
 */
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, of, throwError } from 'rxjs';
import { catchError, map, switchMap, timeout } from 'rxjs/operators';
import { CHAT_API_BASE_URL } from '../chat-config';
import { PropertyCard, PropertyDetail } from '../models/catalog.model';
import { ChatMessage, LocationResolution, RankedProperty, SearchIntent } from '../models/chat.model';
import { PropertyService } from '../services/property.service';
import { CandidateFetcher } from './candidate.fetcher';
import { IntentParser, needsFollowUp } from './intent.parser';
import { LocationResolver } from './location.resolver';
import { ReferenceResolver, buildKnownFacilitiesMap } from './reference.resolver';
import { rankProperties } from './ranker';

/** Contract §4.1: at least 1, at most 5. */
export const TOP_N = 5;

/**
 * How many listings the loosened retry fetches `PropertyDetail` for, to build the ranker's
 * facility map.
 *
 * Tune this to trade requests against facility-fit diversity: lower means fewer round trips
 * on the fallback path, higher means a listing with the right facilities has more room to
 * climb into the top five from further down the budget-and-distance ordering.
 *
 * The retry needs a real facility map to score facility fit, and facilities live only on
 * `PropertyDetail` - one request per listing. Ranking all fifty candidates would be fifty
 * requests for a page that shows five. So the retry ranks once without facilities to get a
 * shortlist, fetches details for this many, and re-ranks those with the map.
 */
export const FALLBACK_DETAIL_FETCH_POOL_SIZE = 8;

/** How much the retry relaxes the budget. Applied to a copy; the original intent is not touched. */
export const FALLBACK_BUDGET_MULTIPLIER = 1.2;

/** Contract §7: 30 s, against a recommended 10 s server-side timeout. */
export const COMPOSE_TIMEOUT_MS = 30_000;

/** The one follow-up the chatbot has wording for. See `intent.parser.needsFollowUp`. */
export const FOLLOW_UP_QUESTION = 'Aapka monthly budget kitna hai?';

/**
 * A listing as `/ai/compose` receives it: `PropertyCard`, with `distanceKm` replaced by the
 * distance measured from the person (contract §2.2.1) and `averageRating` merged in.
 *
 * `averageRating` is an addition to the shape the contract currently documents - see the
 * handover note in §6 of that document, which must be moved to Option A for this field to
 * mean anything on the backend.
 */
export interface ComposeHostel extends PropertyCard {
  averageRating: number | null;
}

/** Contract §4.1. */
export interface ComposeRequest {
  hostels: ComposeHostel[];
  language: 'roman-ur' | 'en';
  mode?: 'normal' | 'fallback';
}

/** Contract §4.2. */
export interface ComposeResponse {
  reply: string;
}

/** Which call failed, so the two error tables are not confused with each other. */
type Stage = 'parse' | 'compose';

interface StageFailure {
  stage: Stage;
  status: number;
  language: 'roman-ur' | 'en';
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly http = inject(HttpClient);
  private readonly parser = inject(IntentParser);
  private readonly location = inject(LocationResolver);
  private readonly reference = inject(ReferenceResolver);
  private readonly fetcher = inject(CandidateFetcher);
  private readonly properties = inject(PropertyService);

  private readonly base = inject(CHAT_API_BASE_URL);

  private readonly history: ChatMessage[] = [];

  /** The conversation so far. A copy, so a caller rendering it cannot rewrite it. */
  getHistory(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * One turn. Answers with the assistant's message and appends both turns to the history.
   *
   * Composed rather than subscribed: every branch stays inside the stream, so a caller that
   * unsubscribes - a widget closed mid-search - cancels the requests still in flight instead
   * of leaving them to write into a conversation nobody is reading.
   */
  handleUserMessage(text: string): Observable<ChatMessage> {
    const userTurn: ChatMessage = { role: 'user', text, timestamp: Date.now() };

    return this.parser.parseUserMessage(text).pipe(
      // Tagged at the point of failure, because §3.5 and §4.5 say different things about the
      // same status code and by the outer catch there is no way left to tell them apart.
      catchError((error: unknown) => throwError(() => stageFailure('parse', error, 'roman-ur'))),
      switchMap((intent) =>
        needsFollowUp(intent) ? of(FOLLOW_UP_QUESTION) : this.searchAndCompose(intent),
      ),
      catchError((error: unknown) => of(this.wordingFor(error))),
      map((reply) => this.record(userTurn, reply)),
    );
  }

  /** Steps 3 to 8: locate, search, rank, retry if empty, enrich, compose. */
  private searchAndCompose(intent: SearchIntent): Observable<string> {
    // One place name, in the order of how much it narrows: a landmark beats an area beats a
    // city. The resolver still prefers a real browser position over any of them.
    const placeText = intent.landmarkName ?? intent.areaName ?? intent.cityName;

    return forkJoin({
      location: this.location.resolveLocation(placeText),
      facilityIds: this.reference.resolveFacilityNames(intent.facilityNames),
    }).pipe(
      switchMap(({ location, facilityIds }) =>
        this.fetcher.fetchCandidates(intent, location.cityId, facilityIds).pipe(
          switchMap((candidates) => {
            // No `knownFacilities` on this pass, deliberately: the search sent `facilityIds`,
            // so the server has already excluded anything lacking them and the ranker's
            // default assumption of a full match is the correct one.
            const ranked = rankProperties(candidates, intent, location.coords).slice(0, TOP_N);
            return ranked.length > 0
              ? of({ ranked, mode: 'normal' as const })
              : this.retryLoosened(intent, location);
          }),
        ),
      ),
      switchMap(({ ranked, mode }) =>
        ranked.length === 0
          ? of(noResultsText(intent.language))
          : this.enrichAndCompose(ranked, intent, mode),
      ),
    );
  }

  /**
   * Step 6: one retry, looser, and only one.
   *
   * Facilities are dropped from the query and the budget is stretched by a fifth - on a copy
   * of the intent, so nothing downstream sees a budget the person did not give. Because the
   * server is no longer filtering on facilities, the ranker now needs the real map to score
   * them, which is what the second ranking pass is for.
   */
  private retryLoosened(
    intent: SearchIntent,
    location: LocationResolution,
  ): Observable<{ ranked: RankedProperty[]; mode: 'fallback' }> {
    const loosened: SearchIntent = { ...intent };
    if (intent.budgetMax != null) {
      loosened.budgetMax = Math.round(intent.budgetMax * FALLBACK_BUDGET_MULTIPLIER);
    }

    return this.fetcher.fetchCandidates(loosened, location.cityId, undefined).pipe(
      switchMap((candidates) => {
        const pool = rankProperties(candidates, loosened, location.coords).slice(
          0,
          FALLBACK_DETAIL_FETCH_POOL_SIZE,
        );
        if (pool.length === 0) return of({ ranked: [], mode: 'fallback' as const });

        return this.knownFacilitiesFor(pool.map((r) => r.property.id)).pipe(
          map((known) => ({
            ranked: rankProperties(
              pool.map((r) => r.property),
              loosened,
              location.coords,
              known,
            ).slice(0, TOP_N),
            mode: 'fallback' as const,
          })),
        );
      }),
    );
  }

  /**
   * Property id to facility names, for the ranker.
   *
   * `PropertyCard` carries no facilities, so this is the only way to get them: one
   * `GET /properties/{id}` each. A listing whose detail cannot be fetched is simply left out
   * of the map, which the ranker reads as "unknown" and scores as a match - the same reading
   * it gives a listing the server already filtered.
   */
  private knownFacilitiesFor(ids: number[]): Observable<ReadonlyMap<number, readonly string[]>> {
    return forkJoin(
      ids.map((id) =>
        this.properties.detail(id).pipe(catchError(() => of(null as PropertyDetail | null))),
      ),
    ).pipe(
      map((details) => buildKnownFacilitiesMap(details.filter((d): d is PropertyDetail => !!d))),
    );
  }

  /** Steps 7 and 8: merge the rating and the measured distance, then ask for the reply. */
  private enrichAndCompose(
    ranked: RankedProperty[],
    intent: SearchIntent,
    mode: 'normal' | 'fallback',
  ): Observable<string> {
    return forkJoin(
      ranked.map((r) =>
        // One review is enough: the page carries `averageRating` in its envelope. A listing
        // with no reviews, or a request that fails, contributes null rather than a zero -
        // contract §4.3 C2 has the backend write "maloom nahi" for it.
        this.properties.reviews(r.property.id, 1, 1).pipe(
          map((page) => (typeof page.averageRating === 'number' ? page.averageRating : null)),
          catchError(() => of(null)),
        ),
      ),
    ).pipe(
      map((ratings) =>
        ranked.map(
          (r, index): ComposeHostel => ({
            ...r.property,
            // Contract §2.2.1: in a compose payload this is the distance from the person,
            // measured here, not the API's distance from a seeded landmark.
            distanceKm: r.distanceKm ?? null,
            averageRating: ratings[index],
          }),
        ),
      ),
      switchMap((hostels) => this.compose(hostels, intent.language, mode)),
    );
  }

  /** The one HTTP call this file makes itself. Contract §4. */
  private compose(
    hostels: ComposeHostel[],
    language: 'roman-ur' | 'en',
    mode: 'normal' | 'fallback',
  ): Observable<string> {
    const body: ComposeRequest = { hostels, language, mode };

    return this.http.post<ComposeResponse>(`${this.base}/ai/compose`, body).pipe(
      timeout(COMPOSE_TIMEOUT_MS),
      switchMap((response) => {
        const reply = response?.reply;
        if (typeof reply === 'string' && reply.trim().length > 0) return of(reply);
        // §4.2 promises a non-empty string. Anything else is the contract broken, and there
        // is nothing safe to show - unlike a bad parse, there is no useful question to fall
        // back to - so it is treated as the service failing.
        return throwError(() => stageFailure('compose', new HttpErrorResponse({ status: 502 }), language));
      }),
      catchError((error: unknown) =>
        isStageFailure(error)
          ? throwError(() => error)
          : throwError(() => stageFailure('compose', error, language)),
      ),
    );
  }

  /**
   * What to say when a call failed.
   *
   * The two error tables in the contract agree on 429, 502 and 504 and disagree on 400:
   * §3.5 treats a parse 400 as the person's message being unusable ("I didn't catch that"),
   * while §4.5 treats a compose 400 as a bug in this frontend - a malformed payload it
   * built - to be logged and shown as a generic failure. Hence the stage tag.
   */
  private wordingFor(error: unknown): string {
    if (!isStageFailure(error)) return generic('roman-ur');
    const { stage, status, language } = error;

    if (stage === 'compose' && status === 400) {
      // §4.5: "Bug in the frontend; logged, generic failure shown."
      console.error(
        '[chat] POST /ai/compose rejected the payload with 400. This is a frontend defect - ' +
          'the request did not match AI_ENDPOINTS_CONTRACT.md §4.1.',
      );
      return generic(language);
    }

    switch (status) {
      case 400:
        return language === 'en'
          ? "Sorry, I didn't quite catch that. Could you put it another way?"
          : 'Maaf kijiye, main samajh nahi paya. Thora aur wazahat se likh dein?';
      case 429:
        return language === 'en'
          ? 'One moment — too many requests just now. Please try again shortly.'
          : 'Ek lamha rukiye — abhi bohot requests aa rahi hain. Thori dair baad koshish karein.';
      default:
        return language === 'en'
          ? 'The assistant is unavailable right now. Please try again in a little while.'
          : 'Assistant abhi dastyab nahi hai. Thori dair baad dobara koshish karein.';
    }
  }

  /** Both turns land together, so the history can never hold a question with no answer. */
  private record(userTurn: ChatMessage, reply: string): ChatMessage {
    const assistantTurn: ChatMessage = {
      role: 'assistant',
      text: reply,
      timestamp: Date.now(),
    };
    this.history.push(userTurn, assistantTurn);
    return assistantTurn;
  }
}

/** Contract §4.5: the frontend never composes a listing reply locally, so this names none. */
function noResultsText(language: 'roman-ur' | 'en'): string {
  return language === 'en'
    ? 'No hostels matched what you asked for, and nothing close enough to suggest either. Try widening the budget or the area.'
    : 'Aapki requirements ke mutabiq koi hostel nahi mila, aur koi qareeb tareen option bhi nahi. Budget ya ilaqa thora wide karke dekhein.';
}

function generic(language: 'roman-ur' | 'en'): string {
  return language === 'en'
    ? 'Something went wrong on my side. Please try again.'
    : 'Meri taraf se kuch ghalat ho gaya. Dobara koshish karein.';
}

function stageFailure(stage: Stage, error: unknown, language: 'roman-ur' | 'en'): StageFailure {
  // A timeout or a network drop has no status of its own; both mean the same thing to the
  // person as a 504, so they are answered with the same wording.
  const status = error instanceof HttpErrorResponse ? error.status : 0;
  return { stage, status, language };
}

function isStageFailure(value: unknown): value is StageFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stage' in value &&
    'status' in value &&
    'language' in value
  );
}
