/**
 * Shapes the AI hostel-search chatbot is built from - what a message is parsed into, where
 * the person turned out to be, and what comes back ranked.
 *
 * Nothing here describes a listing: `PropertyCard` and `PropertyFilters` already do that in
 * `catalog.model.ts` and are imported rather than restated, so a field the catalogue gains
 * reaches the chatbot without a second edit. This file is types only - no logic, no
 * constants, no runtime cost.
 */
import { PropertyCard, PropertyFilters } from './catalog.model';

/**
 * One message parsed into something searchable.
 *
 * Every optional field is genuinely optional: the person is asked at most one question, so
 * anything they did not say stays absent and simply does not become a filter. An absent
 * field means "no opinion", never "match nothing" - the same distinction `toParams` makes.
 *
 * `genderPolicy` and `roomType` are plain strings on purpose. They arrive from a language
 * model, which can return anything, and are only narrowed to the catalogue's `GenderPolicy`
 * and `RoomType` unions once validated - typing them as those unions here would be claiming
 * a guarantee this shape cannot make.
 */
export interface SearchIntent {
  /** Rupees per month. "25k", "25 hazar" and "pchees hazar" all land here as 25000. */
  budgetMax?: number;
  /** True when the person asked for somewhere near them rather than near a named place. */
  nearMe?: boolean;
  cityName?: string;
  areaName?: string;
  /** A university or workplace by name; resolved against `/locations/suggest`. */
  landmarkName?: string;
  /** Unvalidated: narrowed to `GenderPolicy` after checking, not before. */
  genderPolicy?: string | null;
  /** Facilities as the person named them ("wifi", "mess"), not as ids. Never absent. */
  facilityNames: string[];
  /** Unvalidated: narrowed to `RoomType` after checking, not before. */
  roomType?: string;
  /** Which language to answer in - the reply is composed in whatever they wrote in. */
  language: 'roman-ur' | 'en';
  /**
   * The one thing worth interrupting for, or null to search immediately. Only a field the
   * search is useless without belongs here; everything else is answered with a wider search
   * rather than a question.
   */
  missingField: string | null;
}

/** Where the browser says the person is. Degrees, as the Geolocation API reports them. */
export interface UserCoords {
  lat: number;
  lng: number;
}

/**
 * What resolving "near me" actually settled on.
 *
 * `coords` and `cityId` are both optional because the three sources produce different
 * amounts: GPS gives a point, a landmark gives a city without a point of the person's own,
 * and a manually named city gives only the city. `source` says which of those happened, so
 * a caller can tell a real distance from an approximate one instead of guessing from which
 * fields are filled.
 */
export interface LocationResolution {
  coords?: UserCoords;
  cityId?: number;
  source: 'gps' | 'landmark' | 'manual';
}

/**
 * One scored candidate. Generic because ranking is arithmetic over coordinates and rent and
 * does not care what it is ranking - which is also what makes it testable without the API.
 */
export interface RankedResult<T = unknown> {
  property: T;
  /** 0 to 1. Composed from budget fit, distance, facilities, availability and trust. */
  score: number;
  /**
   * Straight-line kilometres from the person, or absent when there is no position to
   * measure from - over plain http the browser withholds geolocation entirely, and an
   * absent distance is the ordinary case there rather than an error.
   */
  distanceKm?: number;
}

/** What the ranker actually returns, named once so callers do not repeat the generic. */
export type RankedProperty = RankedResult<PropertyCard>;

/**
 * The bridge between a parsed message and a request: filters the catalogue already
 * understands, plus the location they were derived from, which ranking still needs after
 * the search has returned.
 */
export interface ChatSearchPlan {
  filters: PropertyFilters;
  location: LocationResolution;
}

/** One turn in the transcript. `timestamp` is `Date.now()` milliseconds. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}
