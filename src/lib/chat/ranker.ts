/**
 * Ranking, done in arithmetic rather than by a language model.
 *
 * A model asked to order five hostels by price and distance will give a different answer on
 * a second run, cannot be unit tested, and costs a round trip to produce a number this file
 * produces in microseconds. So the model reads the sentence and writes the reply, and
 * everything between those two points - filtering, measuring, scoring, ordering - happens
 * here, where it is deterministic and can be checked.
 *
 * Nothing in this file touches the network, the session, Angular's injector or the clock.
 * The same inputs always produce the same output, which is what makes `ranker.spec.ts`
 * possible without a single mock.
 */
import { PropertyCard } from '../models/catalog.model';
import { RankedResult, SearchIntent, UserCoords } from '../models/chat.model';
import { haversineKm } from '../utils/geo.util';

/**
 * Re-exported so that scoring and the distance it is scored on still arrive from one import,
 * and so that anything already taking `haversineKm` from this module keeps working. The
 * implementation lives in `utils/geo.util.ts` because `geolocation.service.ts` needs the
 * same measurement and neither module owns it.
 */
export { haversineKm };

/**
 * How the five signals trade off against one another. They sum to 1, so a score is always
 * between 0 and 1 and two scores are comparable across different searches.
 *
 * Budget leads because it is the one thing a person always states and the one thing that
 * makes a listing useless if it is wrong. Distance is close behind because "near me" is the
 * question being asked. Trust is deliberately small: an inspection badge should break a tie,
 * not carry a listing past a cheaper, closer one.
 */
export const RANK_WEIGHTS = {
  budget: 0.35,
  distance: 0.3,
  facilities: 0.2,
  availability: 0.1,
  trust: 0.05,
} as const;

/**
 * The distance at which the distance signal is worth half its maximum. Two kilometres is
 * roughly the edge of "walkable" in a Pakistani city, which is the judgement this number
 * encodes.
 *
 * A reciprocal is used rather than a cutoff so that ordering survives at every distance: with
 * a horizon, everything beyond it scores zero and forty kilometres ties with fifteen. Here
 * the score only ever approaches zero, so the nearer listing always wins.
 */
export const DISTANCE_HALF_SCORE_KM = 2;

/** Scores are rounded here so that float noise cannot reorder two genuinely equal results. */
const SCORE_PRECISION = 6;

/**
 * What the listing actually costs every month.
 *
 * `maxRent` on the API filters `monthlyRent` alone, so a search for 25,000 can return a room
 * whose bill is 28,500 once utilities and mess are added. Quoting that room as "Rs 23,000"
 * would be true and useless. The security deposit is excluded on purpose: it is paid once,
 * not monthly, and folding it in would make a cheap room look expensive.
 */
export function computeTotalMonthly(card: PropertyCard, wantsMess: boolean): number {
  return card.monthlyRent + card.utilitiesCharge + (wantsMess ? card.messCharge : 0);
}

/** Did they ask for mess? Only then does `messCharge` belong in the monthly total. */
export function wantsMess(intent: SearchIntent): boolean {
  return intent.facilityNames.some((name) => name.trim().toLowerCase().includes('mess'));
}

/**
 * Filter, score and order candidates. Returns the whole ranked list - how many to show is
 * the caller's decision, not the ranker's.
 *
 * `userCoords` is optional because over plain http the browser withholds geolocation
 * entirely, which is the ordinary case on the deployed demo rather than an error. Without a
 * position every listing scores the same on distance, so the other four signals decide the
 * order instead of the function refusing to run.
 *
 * `knownFacilities` maps a property id to the facility names it actually has. It is optional
 * because `PropertyCard` carries no facilities at all - only `PropertyDetail` does - so a
 * caller that has not fetched details cannot supply it. See the note on `facilityFit` below.
 */
export function rankProperties(
  candidates: PropertyCard[],
  intent: SearchIntent,
  userCoords?: UserCoords,
  knownFacilities?: ReadonlyMap<number, readonly string[]>,
): RankedResult<PropertyCard>[] {
  const mess = wantsMess(intent);
  const budget = intent.budgetMax;
  const gender = normalise(intent.genderPolicy);

  const survivors = candidates.filter((card) => {
    // Nothing to move into is not a cheaper option, it is a different listing.
    if (card.availableBeds === 0) return false;
    // A budget is a ceiling on the real monthly cost, not on the advertised rent.
    if (budget != null && computeTotalMonthly(card, mess) > budget) return false;
    // An unstated preference is not a preference: no filter rather than no results.
    if (gender != null && normalise(card.genderPolicy) !== gender) return false;
    return true;
  });

  const scored = survivors.map((card) => {
    const distanceKm = userCoords
      ? haversineKm(userCoords, { lat: card.latitude, lng: card.longitude })
      : undefined;

    const score = round(
      RANK_WEIGHTS.budget * budgetFit(card, budget, mess) +
        RANK_WEIGHTS.distance * distanceFit(distanceKm) +
        RANK_WEIGHTS.facilities * facilityFit(card, intent, knownFacilities) +
        RANK_WEIGHTS.availability * availabilityFit(card) +
        RANK_WEIGHTS.trust * (card.hasInspectionBadge ? 1 : 0),
    );

    const result: RankedResult<PropertyCard> = { property: card, score };
    if (distanceKm !== undefined) result.distanceKm = distanceKm;
    return result;
  });

  // Sorted on a copy: a ranker that reorders its caller's array is a bug waiting to be
  // blamed on something else. Ties fall back to distance and then to id so that the same
  // input always produces byte-identical output, whatever the engine's sort does.
  return [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Compared before subtracting, because with no position held both sides are Infinity
    // and the difference would be NaN - a comparator returning NaN leaves the order up to
    // the engine, which is the one thing this tie-break exists to prevent.
    const aDistance = a.distanceKm ?? Infinity;
    const bDistance = b.distanceKm ?? Infinity;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return a.property.id - b.property.id;
  });
}

/**
 * How much of the budget is left over, as a fraction of it. A room at the ceiling scores 0
 * and a free one scores 1, so cheaper wins where everything else is equal.
 *
 * No stated budget means no opinion, which scores neutral rather than 0 - scoring it 0 would
 * quietly punish every listing for a question the person was never asked.
 */
function budgetFit(card: PropertyCard, budget: number | undefined, mess: boolean): number {
  if (budget == null || budget <= 0) return 0.5;
  return clamp01((budget - computeTotalMonthly(card, mess)) / budget);
}

/** 1 at the door, 0.5 at `DISTANCE_HALF_SCORE_KM`, approaching 0 but never reaching it. */
function distanceFit(distanceKm: number | undefined): number {
  if (distanceKm === undefined) return 0.5;
  return 1 / (1 + distanceKm / DISTANCE_HALF_SCORE_KM);
}

/**
 * The fraction of the requested facilities the listing has.
 *
 * Unknown is scored as a match, not as a miss, and that is a deliberate choice rather than
 * an optimistic one: the search sends `facilityIds`, so the server has already excluded
 * every listing that lacks them. Scoring unknown as 0 would mean punishing listings for
 * something the API has already guaranteed. When the caller has relaxed those filters - the
 * "no exact match" path - it passes `knownFacilities` and this becomes a real measurement.
 */
function facilityFit(
  card: PropertyCard,
  intent: SearchIntent,
  knownFacilities?: ReadonlyMap<number, readonly string[]>,
): number {
  const wanted = intent.facilityNames;
  if (wanted.length === 0) return 1;

  const have = knownFacilities?.get(card.id);
  if (!have) return 1;

  const haveSet = have.map((name) => name.trim().toLowerCase());
  const matched = wanted.filter((name) => {
    const needle = name.trim().toLowerCase();
    return haveSet.some((owned) => owned.includes(needle) || needle.includes(owned));
  });
  return clamp01(matched.length / wanted.length);
}

/** Proportion of beds free. A listing with one bed left is nearly gone; one half-empty is not. */
function availabilityFit(card: PropertyCard): number {
  if (card.totalBeds <= 0) return 0;
  return clamp01(card.availableBeds / card.totalBeds);
}

/** Case and spacing are the model's to get wrong, not the person's. */
function normalise(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  const factor = 10 ** SCORE_PRECISION;
  return Math.round(value * factor) / factor;
}
