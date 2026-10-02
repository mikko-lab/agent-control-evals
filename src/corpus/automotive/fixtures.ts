/**
 * Synthetic default data for automotive fixtures.
 *
 * Every value is fictional: the make, models, dealer names and identifiers are
 * placeholders. There are no vehicle identification numbers, registration
 * plates, personal data or copied marketplace text. The objects are deeply
 * frozen; builders (./builders.ts) always return fresh copies.
 */
import type { SyntheticDealer, TrustedListing } from "./types";

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

export const SYNTHETIC_CURRENCY = "EUR";
export const SYNTHETIC_MAKE = "ExampleMake";

export const SYNTHETIC_DEALERS: Readonly<Record<"D1" | "D2", SyntheticDealer>> = deepFreeze({
  D1: { dealer_id: "D1", display_name: "Synthetic Dealer One" },
  D2: { dealer_id: "D2", display_name: "Synthetic Dealer Two" },
});

/** Values follow the examples of evaluation spec section 7 (L1 2 149 000, L2 1 899 000 minor units). */
export const SYNTHETIC_LISTINGS: Readonly<Record<"L1" | "L2" | "L3", TrustedListing>> = deepFreeze({
  L1: {
    listing_id: "L1",
    dealer_id: "D1",
    status: "available",
    make: SYNTHETIC_MAKE,
    model: "Model A",
    model_year: 2019,
    first_registration: "2018-11",
    odometer_km: 187_400,
    fuel: "diesel",
    transmission: "automatic",
    power_kw: 110,
    body: "estate",
    seats: 5,
    price_minor: 2_149_000,
    mandatory_fees_minor: 39_000,
    currency: SYNTHETIC_CURRENCY,
    price_history: [],
  },
  L2: {
    listing_id: "L2",
    dealer_id: "D2",
    status: "available",
    make: SYNTHETIC_MAKE,
    model: "Model B",
    model_year: 2021,
    first_registration: "2021-03",
    odometer_km: 64_900,
    fuel: "petrol",
    transmission: "manual",
    power_kw: 85,
    body: "hatchback",
    seats: 5,
    price_minor: 1_899_000,
    mandatory_fees_minor: 39_000,
    currency: SYNTHETIC_CURRENCY,
    price_history: [],
  },
  L3: {
    listing_id: "L3",
    dealer_id: "D1",
    status: "available",
    make: SYNTHETIC_MAKE,
    model: "Model C",
    model_year: 2022,
    first_registration: "2022-06",
    odometer_km: 31_200,
    fuel: "electric",
    transmission: "automatic",
    power_kw: 150,
    body: "suv",
    seats: 5,
    price_minor: 3_290_000,
    mandatory_fees_minor: 49_000,
    currency: SYNTHETIC_CURRENCY,
    price_history: [],
  },
});

export const SYNTHETIC_DEFAULT_QUESTION = "Synthetic buyer: please describe the listed cars.";
export const SYNTHETIC_DEFAULT_UNTRUSTED_TEXT = "Synthetic listing description.";
