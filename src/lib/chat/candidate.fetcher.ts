/**
 * The one search the chatbot makes.
 *
 * Everything the server is good at - narrowing by city, rent, facilities and availability -
 * happens here, in a single request. Everything the server cannot do - measuring from where
 * the person actually is, counting utilities and mess into the budget, weighing five signals
 * against each other - happens afterwards in the ranker, on the page of candidates this
 * returns.
 *
 * The split matters because the API caps a page at fifty. Filtering too loosely here wastes
 * that page on listings the ranker will throw away; filtering too tightly means the best
 * answer was never in the page to begin with.
 */
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  GENDER_POLICIES,
  PAGE_SIZE_MAX,
  PropertyCard,
  PropertyFilters,
  ROOM_TYPES,
} from '../models/catalog.model';
import { SearchIntent } from '../models/chat.model';
import { PropertyService } from '../services/property.service';

@Injectable({ providedIn: 'root' })
export class CandidateFetcher {
  private readonly properties = inject(PropertyService);

  /**
   * One page of listings worth ranking. `cityId` and `facilityIds` are passed in rather than
   * derived here because resolving them is somebody else's job - the location resolver knows
   * where "near me" landed, and `ReferenceResolver` knows that "wifi" is facility 1.
   *
   * Returns the page's `items`; the envelope's `totalCount` is not the chatbot's business,
   * which answers with a handful of recommendations rather than a result count.
   */
  fetchCandidates(
    intent: SearchIntent,
    cityId?: number,
    facilityIds?: number[],
  ): Observable<PropertyCard[]> {
    return this.properties
      .search(buildCandidateFilters(intent, cityId, facilityIds))
      .pipe(map((page) => page.items));
  }
}

/**
 * The filters one message turns into.
 *
 * `maxRent` is deliberately the loose ceiling: the server compares it against `monthlyRent`
 * alone, so a listing inside it can still be over budget once utilities and the mess they
 * asked for are added. Tightening for that here would mean sending a lower ceiling and
 * losing listings whose utilities are zero. The real total is checked in the ranker, where
 * every charge is known.
 *
 * Pure, and exported, so the assembly can be tested without a fake HTTP backend.
 */
export function buildCandidateFilters(
  intent: SearchIntent,
  cityId?: number,
  facilityIds?: number[],
): PropertyFilters {
  const filters: PropertyFilters = {
    // A bed that does not exist is not a cheaper option, so this is never negotiable.
    availableOnly: true,
    // Distance would be the obvious sort, but the API only measures from a seeded landmark
    // and refuses `sort=Distance` without one. The person's own position is not a landmark,
    // so ordering by distance is the ranker's job and this asks for the newest instead.
    sort: 'Recent',
    page: 1,
    // The largest page the API allows - it answers 400 rather than clamping. Ranking is
    // only as good as the candidates it is given, so this asks for as many as it may.
    pageSize: PAGE_SIZE_MAX,
  };

  if (cityId != null) filters.cityId = cityId;
  if (intent.budgetMax != null) filters.maxRent = intent.budgetMax;
  // An empty list is not the same as no opinion: sending `facilityIds=` is a 400, and a
  // person who named no facility has not asked to be narrowed at all.
  if (facilityIds != null && facilityIds.length > 0) filters.facilityIds = facilityIds;

  // Both of these narrow the page rather than the results, which is the whole point of
  // sending them. A page is capped at fifty: asking for boys' hostels and filtering the
  // girls' ones out afterwards spends most of that page on listings the ranker will throw
  // away, and the best answer may never have been in the page at all.
  const genderPolicy = matchEnum(GENDER_POLICIES, intent.genderPolicy);
  if (genderPolicy) filters.genderPolicy = genderPolicy;

  const roomType = matchEnum(ROOM_TYPES, intent.roomType);
  if (roomType) filters.roomType = roomType;

  return filters;
}

/**
 * The enumeration member a loosely-spelled value meant, or nothing.
 *
 * `SearchIntent` types these as plain strings because they arrive from a language model,
 * which will happily answer "boys", "BOYS" or "male". The API accepts the enumeration
 * case-insensitively but refuses anything outside it with a 400, so a value that matches
 * nothing is dropped rather than sent: a person who was misheard should get a wider search,
 * not an error page.
 *
 * Returning the constant's own spelling rather than the caller's keeps the query string in
 * the API's PascalCase, which is what the brief's section 6 says it sends.
 */
function matchEnum<T extends string>(
  allowed: readonly T[],
  value: string | null | undefined,
): T | undefined {
  if (value == null) return undefined;
  const needle = value.trim().toLowerCase();
  return allowed.find((candidate) => candidate.toLowerCase() === needle);
}
