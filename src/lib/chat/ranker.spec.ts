import { describe, expect, it } from 'vitest';
import { PropertyCard } from '../models/catalog.model';
import { SearchIntent, UserCoords } from '../models/chat.model';
import {
  DISTANCE_HALF_SCORE_KM,
  RANK_WEIGHTS,
  computeTotalMonthly,
  haversineKm,
  rankProperties,
  wantsMess,
} from './ranker';

/**
 * The ranker decides which four listings a person sees out of forty, and gets no second
 * chance to be right: a room ordered third instead of first is not a visible bug, it is
 * simply a worse answer that nobody notices. That is exactly the kind of logic worth pinning
 * to exact numbers.
 *
 * Every expectation here is computed by hand from `RANK_WEIGHTS` and asserted as a literal.
 * Deriving the expected score from the same arithmetic the code uses would pass no matter
 * what the code did.
 */

const USER: UserCoords = { lat: 31.5204, lng: 74.3587 };

/**
 * Kilometres north of the user, as a latitude offset. Along a meridian the haversine reduces
 * to `R × Δlatitude`, so a card placed this way sits at exactly the distance asked for and
 * the expected scores below are exact rather than approximate.
 */
function latOffsetKm(km: number): number {
  return ((km / 6371) * 180) / Math.PI;
}

function card(overrides: Partial<PropertyCard>): PropertyCard {
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
    monthlyRent: 10000,
    securityDeposit: 20000,
    utilitiesCharge: 0,
    messCharge: 0,
    latitude: USER.lat,
    longitude: USER.lng,
    primaryThumbnailUrl: null,
    photoCount: 3,
    hasInspectionBadge: false,
    availabilityConfirmedAt: null,
    distanceKm: null,
    ...overrides,
  };
}

function intent(overrides: Partial<SearchIntent>): SearchIntent {
  return {
    budgetMax: 25000,
    genderPolicy: 'Boys',
    facilityNames: [],
    language: 'roman-ur',
    missingField: null,
    ...overrides,
  };
}

describe('haversineKm', () => {
  it('is zero for a point and itself', () => {
    expect(haversineKm(USER, { ...USER })).toBe(0);
  });

  /** One degree of latitude is 111.19 km on this radius, anywhere on the globe. */
  it('measures a degree of latitude', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 2);
  });

  it('does not care which point is first', () => {
    const karachi: UserCoords = { lat: 24.8607, lng: 67.0011 };
    expect(haversineKm(USER, karachi)).toBeCloseTo(haversineKm(karachi, USER), 10);
  });

  it('places a latitude offset at exactly the distance it names', () => {
    const north = { lat: USER.lat + latOffsetKm(10), lng: USER.lng };
    expect(haversineKm(USER, north)).toBeCloseTo(10, 6);
  });
});

describe('computeTotalMonthly', () => {
  const priced = card({ monthlyRent: 20000, utilitiesCharge: 1000, messCharge: 5000 });

  it('adds utilities but leaves mess out when mess was not asked for', () => {
    expect(computeTotalMonthly(priced, false)).toBe(21000);
  });

  it('adds mess when it was', () => {
    expect(computeTotalMonthly(priced, true)).toBe(26000);
  });

  /** The deposit is paid once. Folding it in would make a cheap room look expensive. */
  it('ignores the security deposit', () => {
    expect(computeTotalMonthly(card({ monthlyRent: 10000, securityDeposit: 99999 }), false)).toBe(
      10000,
    );
  });
});

describe('wantsMess', () => {
  it('reads mess out of the requested facilities', () => {
    expect(wantsMess(intent({ facilityNames: ['wifi', 'Mess'] }))).toBe(true);
  });

  it('is false when nothing was asked for', () => {
    expect(wantsMess(intent({ facilityNames: [] }))).toBe(false);
  });
});

describe('rankProperties — ordering', () => {
  // Four listings, each winning on a different signal, with hand-computed scores:
  //
  //   near-cheap  .35(0.60) + .30(1.000) + .20(1) + .10(0.5) + .05(1) = 0.810
  //   near-pricey .35(0.04) + .30(1.000) + .20(1) + .10(0.5) + .05(1) = 0.614
  //   far-cheap   .35(0.60) + .30(0.167) + .20(1) + .10(0.5) + .05(1) = 0.560
  //   mid         .35(0.20) + .30(0.500) + .20(1) + .10(1.0) + .05(0) = 0.520
  const nearCheap = card({ id: 1, monthlyRent: 10000, hasInspectionBadge: true });
  const nearPricey = card({ id: 2, monthlyRent: 24000, hasInspectionBadge: true });
  const farCheap = card({
    id: 3,
    monthlyRent: 10000,
    latitude: USER.lat + latOffsetKm(10),
    hasInspectionBadge: true,
  });
  const mid = card({
    id: 4,
    monthlyRent: 20000,
    latitude: USER.lat + latOffsetKm(DISTANCE_HALF_SCORE_KM),
    availableBeds: 10,
    hasInspectionBadge: false,
  });

  const ranked = rankProperties([mid, farCheap, nearPricey, nearCheap], intent({}), USER);

  it('returns every candidate that survived the filter', () => {
    expect(ranked).toHaveLength(4);
  });

  it('orders them cheapest-and-nearest first', () => {
    expect(ranked.map((r) => r.property.id)).toEqual([1, 2, 3, 4]);
  });

  it('scores each one exactly', () => {
    expect(ranked[0].score).toBeCloseTo(0.81, 6);
    expect(ranked[1].score).toBeCloseTo(0.614, 6);
    expect(ranked[2].score).toBeCloseTo(0.56, 6);
    expect(ranked[3].score).toBeCloseTo(0.52, 6);
  });

  it('reports the distance it measured', () => {
    expect(ranked[0].distanceKm).toBeCloseTo(0, 6);
    expect(ranked[2].distanceKm).toBeCloseTo(10, 6);
    expect(ranked[3].distanceKm).toBeCloseTo(2, 6);
  });

  it('does not reorder the array it was given', () => {
    const input = [mid, farCheap, nearPricey, nearCheap];
    rankProperties(input, intent({}), USER);
    expect(input.map((c) => c.id)).toEqual([4, 3, 2, 1]);
  });

  it('is deterministic across repeated runs', () => {
    const once = rankProperties([mid, farCheap, nearPricey, nearCheap], intent({}), USER);
    const twice = rankProperties([nearCheap, mid, nearPricey, farCheap], intent({}), USER);
    expect(twice.map((r) => r.property.id)).toEqual(once.map((r) => r.property.id));
  });
});

describe('rankProperties — hard filters', () => {
  it('drops a listing whose real monthly cost is over budget', () => {
    const affordable = card({ id: 1, monthlyRent: 20000 });
    const over = card({ id: 2, monthlyRent: 30000 });
    const ranked = rankProperties([affordable, over], intent({ budgetMax: 25000 }), USER);
    expect(ranked.map((r) => r.property.id)).toEqual([1]);
  });

  /**
   * The listing is inside budget on rent alone, which is all `maxRent` filters on, and over
   * it once the mess they asked for is added. The API would have returned it; the ranker is
   * the only thing standing between that and quoting a price the person cannot pay.
   */
  it('counts mess against the budget only when mess was asked for', () => {
    const withMess = card({ id: 1, monthlyRent: 20000, utilitiesCharge: 1000, messCharge: 5000 });

    expect(rankProperties([withMess], intent({ facilityNames: [] }), USER)).toHaveLength(1);
    expect(rankProperties([withMess], intent({ facilityNames: ['mess'] }), USER)).toHaveLength(0);
  });

  it('drops a listing with no free bed', () => {
    const full = card({ id: 1, availableBeds: 0 });
    const open = card({ id: 2, availableBeds: 1 });
    expect(rankProperties([full, open], intent({}), USER).map((r) => r.property.id)).toEqual([2]);
  });

  it('drops a listing whose gender policy is not the one asked for', () => {
    const boys = card({ id: 1, genderPolicy: 'Boys' });
    const girls = card({ id: 2, genderPolicy: 'Girls' });
    const ranked = rankProperties([boys, girls], intent({ genderPolicy: 'Boys' }), USER);
    expect(ranked.map((r) => r.property.id)).toEqual([1]);
  });

  /** Whatever casing the model returns is the model's problem, not the person's. */
  it('matches the gender policy regardless of casing', () => {
    const boys = card({ id: 1, genderPolicy: 'Boys' });
    expect(rankProperties([boys], intent({ genderPolicy: '  boys ' }), USER)).toHaveLength(1);
  });

  it('keeps every gender when none was asked for', () => {
    const boys = card({ id: 1, genderPolicy: 'Boys' });
    const girls = card({ id: 2, genderPolicy: 'Girls' });
    expect(rankProperties([boys, girls], intent({ genderPolicy: null }), USER)).toHaveLength(2);
  });

  it('applies no budget ceiling when none was stated', () => {
    const expensive = card({ id: 1, monthlyRent: 90000 });
    expect(rankProperties([expensive], intent({ budgetMax: undefined }), USER)).toHaveLength(1);
  });
});

describe('rankProperties — without a position', () => {
  /**
   * Over plain http the browser withholds geolocation entirely, which is the ordinary case
   * on the deployed demo. Losing distance should cost the distance signal, not the answer.
   */
  const near = card({ id: 1, monthlyRent: 10000, hasInspectionBadge: true });
  const far = card({
    id: 2,
    monthlyRent: 10000,
    latitude: USER.lat + latOffsetKm(40),
    hasInspectionBadge: true,
  });

  it('still ranks, and does not throw', () => {
    expect(rankProperties([near, far], intent({}), undefined)).toHaveLength(2);
  });

  it('leaves distance off the result rather than guessing at it', () => {
    const ranked = rankProperties([near], intent({}), undefined);
    expect(ranked[0].distanceKm).toBeUndefined();
  });

  it('scores distance neutrally, so the other four signals decide', () => {
    // .35(0.60) + .30(0.5 neutral) + .20(1) + .10(0.5) + .05(1)
    //   = 0.21 + 0.15 + 0.20 + 0.05 + 0.05 = 0.66, for both, forty km apart.
    const ranked = rankProperties([near, far], intent({}), undefined);
    expect(ranked[0].score).toBeCloseTo(0.66, 6);
    expect(ranked[1].score).toBeCloseTo(0.66, 6);
  });

  /** Equal scores are broken by id, so the output is stable whatever the engine's sort does. */
  it('breaks a dead heat by id', () => {
    const ranked = rankProperties([far, near], intent({}), undefined);
    expect(ranked.map((r) => r.property.id)).toEqual([1, 2]);
  });
});

describe('rankProperties — facilities', () => {
  const a = card({ id: 1 });
  const b = card({ id: 2 });

  /**
   * The search sends `facilityIds`, so the server has already excluded anything lacking
   * them. Without a facilities map the ranker treats that guarantee as met rather than
   * punishing every listing for something it cannot see - `PropertyCard` carries no
   * facilities at all.
   */
  it('assumes the server already filtered when no facility map is given', () => {
    const ranked = rankProperties([a], intent({ facilityNames: ['wifi'] }), USER);
    // .35(0.60) + .30(1) + .20(1) + .10(0.5) + .05(0)
    //   = 0.21 + 0.30 + 0.20 + 0.05 + 0 = 0.76
    expect(ranked[0].score).toBeCloseTo(0.76, 6);
  });

  it('measures the fraction actually present when the map is given', () => {
    const known = new Map<number, readonly string[]>([
      [1, ['WiFi', 'Mess', 'Laundry']],
      [2, ['WiFi']],
    ]);
    const ranked = rankProperties(
      [b, a],
      intent({ facilityNames: ['wifi', 'mess'], budgetMax: 40000 }),
      USER,
      known,
    );
    expect(ranked.map((r) => r.property.id)).toEqual([1, 2]);
  });

  it('scores a listing with none of them at zero on that signal', () => {
    const known = new Map<number, readonly string[]>([[1, ['Parking']]]);
    const ranked = rankProperties([a], intent({ facilityNames: ['wifi'] }), USER, known);
    // .35(0.60) + .30(1) + .20(0) + .10(0.5) + .05(0) = 0.56
    expect(ranked[0].score).toBeCloseTo(0.56, 6);
  });
});

describe('RANK_WEIGHTS', () => {
  /** Scores are only comparable across searches while these sum to exactly one. */
  it('sums to one', () => {
    const total = Object.values(RANK_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});
