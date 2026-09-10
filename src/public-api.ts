/**
 * Everything this package offers a host application.
 *
 * The widget and `provideRoomRaahChat` are all most callers need. The rest is exported
 * because the pieces are useful on their own: the ranker is pure arithmetic that can be
 * tested and tuned in isolation, and the resolvers are how a different interface - a voice
 * assistant, a command palette - would reuse the same search without the bubble.
 */
export { provideRoomRaahChat, CHAT_API_BASE_URL } from './lib/chat-config';

export { ChatWidgetComponent, UNEXPECTED_ERROR_TEXT } from './lib/ui/chat-widget.component';

export {
  ChatService,
  FOLLOW_UP_QUESTION,
  TOP_N,
  FALLBACK_DETAIL_FETCH_POOL_SIZE,
  FALLBACK_BUDGET_MULTIPLIER,
  COMPOSE_TIMEOUT_MS,
} from './lib/chat/chat.service';
export type { ComposeHostel, ComposeRequest, ComposeResponse } from './lib/chat/chat.service';

export {
  IntentParser,
  needsFollowUp,
  normaliseIntent,
  safeDefaultIntent,
  PARSE_TIMEOUT_MS,
  PARSE_TEXT_MAX_LENGTH,
} from './lib/chat/intent.parser';

export {
  LocationResolver,
  nearestCentroid,
  CITY_CENTROIDS,
  MAX_CITY_MATCH_KM,
} from './lib/chat/location.resolver';

export {
  ReferenceResolver,
  matchFacilityIds,
  normaliseFacilityToken,
  buildKnownFacilitiesMap,
} from './lib/chat/reference.resolver';

export { CandidateFetcher, buildCandidateFilters } from './lib/chat/candidate.fetcher';

export {
  rankProperties,
  computeTotalMonthly,
  wantsMess,
  haversineKm,
  RANK_WEIGHTS,
  DISTANCE_HALF_SCORE_KM,
} from './lib/chat/ranker';

export { haversineKm as haversine } from './lib/utils/geo.util';
export type { GeoPoint } from './lib/utils/geo.util';

export { PropertyService, COMPARE_LIMIT } from './lib/services/property.service';
export { ReferenceService } from './lib/services/reference.service';
export { GeolocationService } from './lib/services/geolocation.service';
export type { Coords, GeolocationState } from './lib/services/geolocation.service';

export type {
  SearchIntent,
  UserCoords,
  LocationResolution,
  RankedResult,
  RankedProperty,
  ChatSearchPlan,
  ChatMessage,
} from './lib/models/chat.model';

export type {
  PropertyCard,
  PropertyDetail,
  PropertyFilters,
  Facility,
  City,
  Area,
  LocationSuggestion,
  Review,
  ReviewPage,
  Page,
  RoomType,
  GenderPolicy,
} from './lib/models/catalog.model';
