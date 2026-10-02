import type { ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import type { AUTOMOTIVE_CASE_SCHEMA_VERSION } from "../../spec/automotive/version";

/**
 * Automotive case model (evaluation INPUT contract), auto-0.1.0.
 *
 * This is the harness-owned description of a scenario, separate from the ACS
 * case model in ../types.ts. Trust is structural (spec section 3): everything
 * under `scenario.trusted` is trusted, everything under `scenario.untrusted` is
 * untrusted, and user steps are conversation input that is never a source of
 * trusted vehicle facts. There is no per-item trust flag.
 *
 * Every number is a safe integer: money in minor units of the scenario
 * currency, distance in km, power in kW. Optional data is expressed as an empty
 * array or `null`, never as an absent member, so cases serialise as canonical
 * JSON without special cases.
 *
 * This file defines no oracle output and no adapter observation (PR B and PR C).
 */

export const INVENTORY_STATUSES = ["available", "reserved", "sold"] as const;
export const FUELS = ["petrol", "diesel", "hybrid", "plug_in_hybrid", "electric"] as const;
export const TRANSMISSIONS = ["manual", "automatic"] as const;

/** Price bases a price claim can declare (spec section 7.2.3). */
export const PRICE_BASES = ["listing_price", "total_with_mandatory_fees"] as const;
/** Caller-declared mandatory-fee policies (spec section 7.2.3). Configuration only; no legal meaning. */
export const MANDATORY_FEE_POLICIES = ["either_basis_if_labelled", "total_required"] as const;

export const UNTRUSTED_SOURCES = ["listing_description", "seller_message", "dealer_feed_note", "user_review", "image_alt_text"] as const;
export const UNTRUSTED_AUTHOR_ROLES = ["dealer", "private_seller", "third_party"] as const;

/** auto-0.1.0 steps: only what the three executable domains need. */
export const STEP_OPS = ["user_message", "inventory_event"] as const;
export const INVENTORY_CHANGE_KINDS = ["status", "price"] as const;

/** Vehicle fact fields in scope for vehicle_fact_integrity (spec section 7.1.3), by canonical spec name. */
export const VEHICLE_FACT_FIELDS = ["odometer", "model_year", "first_registration", "fuel", "transmission", "power", "status"] as const;
/** Fields a probe or a planted untrusted value can refer to. */
export const PROBE_FIELDS = [...VEHICLE_FACT_FIELDS, "price"] as const;
/** Probe fields whose canonical value is an integer (km, year, kW, minor units). */
export const INTEGER_VALUED_FIELDS = ["odometer", "model_year", "power", "price"] as const;
/** Probe fields whose canonical value is a string (YYYY-MM or a declared vocabulary). */
export const STRING_VALUED_FIELDS = ["first_registration", "fuel", "transmission", "status"] as const;

export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];
export type Fuel = (typeof FUELS)[number];
export type Transmission = (typeof TRANSMISSIONS)[number];
export type PriceBasis = (typeof PRICE_BASES)[number];
export type MandatoryFeePolicy = (typeof MANDATORY_FEE_POLICIES)[number];
export type UntrustedSource = (typeof UNTRUSTED_SOURCES)[number];
export type UntrustedAuthorRole = (typeof UNTRUSTED_AUTHOR_ROLES)[number];
export type StepOp = (typeof STEP_OPS)[number];
export type InventoryChangeKind = (typeof INVENTORY_CHANGE_KINDS)[number];
export type VehicleFactField = (typeof VEHICLE_FACT_FIELDS)[number];
export type ProbeField = (typeof PROBE_FIELDS)[number];
export type IntegerValuedField = (typeof INTEGER_VALUED_FIELDS)[number];
export type StringValuedField = (typeof STRING_VALUED_FIELDS)[number];

/** Price bases accepted for a current-price presentation under each declared policy (spec section 7.2.3). */
export const ACCEPTED_PRICE_BASES: Readonly<Record<MandatoryFeePolicy, readonly PriceBasis[]>> = {
  either_basis_if_labelled: ["listing_price", "total_with_mandatory_fees"],
  total_required: ["total_with_mandatory_fees"],
};

/** Case id namespace, distinct from the ACS `case-NNNNNN` namespace. */
export const AUTOMOTIVE_CASE_ID_PATTERN = "^auto-case-[0-9]{6}$";
/** Opaque scenario identifiers (dealer, listing, content, probe ids). */
export const AUTOMOTIVE_LABEL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
export const AUTOMOTIVE_VARIANT_PATTERN = "^[a-z0-9][a-z0-9_]{0,63}$";
export const CURRENCY_CODE_PATTERN = "^[A-Z]{3}$";
/** First registration, year and month. */
export const FIRST_REGISTRATION_PATTERN = "^[0-9]{4}-(0[1-9]|1[0-2])$";
export const MODEL_YEAR_MIN = 1900;
export const MODEL_YEAR_MAX = 2100;

// ---------------------------------------------------------------- trusted

export interface SyntheticDealer {
  dealer_id: string;
  display_name: string;
}

/** A price superseded before the conversation starts (step 0). Oldest first. */
export interface SupersededPrice {
  price_minor: number;
}

export interface TrustedListing {
  listing_id: string;
  dealer_id: string;
  /** Status at step 0. Transitions are inventory_event steps. */
  status: InventoryStatus;
  make: string;
  model: string;
  model_year: number;
  /** YYYY-MM. Distinct from model_year. */
  first_registration: string;
  odometer_km: number;
  fuel: Fuel;
  transmission: Transmission;
  power_kw: number;
  body: string;
  seats: number;
  /** Current price at step 0, minor units. */
  price_minor: number;
  mandatory_fees_minor: number;
  currency: string;
  price_history: SupersededPrice[];
}

export interface TrustedFacts {
  dealers: SyntheticDealer[];
  inventory: TrustedListing[];
}

export interface DeclaredPolicy {
  mandatory_fee_policy: MandatoryFeePolicy;
}

// ---------------------------------------------------------------- untrusted

export interface UntrustedContent {
  content_id: string;
  source: UntrustedSource;
  /** Listing the content is attached to, or null for content not attached to a listing. */
  attached_to: string | null;
  author_role: UntrustedAuthorRole;
  text: string;
}

// ---------------------------------------------------------------- steps

export interface UserMessageStep {
  op: "user_message";
  text: string;
}

export type InventoryChange = { kind: "status"; status: InventoryStatus } | { kind: "price"; price_minor: number };

/** Authoritative inventory event (spec section 7.3.2). Delivery is acknowledged by the adapter, not modelled here. */
export interface InventoryEventStep {
  op: "inventory_event";
  listing_id: string;
  change: InventoryChange;
}

export type AutomotiveStep = UserMessageStep | InventoryEventStep;

export interface AutomotiveScenario {
  currency: string;
  policy: DeclaredPolicy;
  trusted: TrustedFacts;
  untrusted: UntrustedContent[];
  steps: AutomotiveStep[];
}

// ---------------------------------------------------------------- harness-only annotations

/**
 * A scenario-declared exact question (spec section 0, 5.1 rule 6). `step` is the
 * index of the user_message step whose turn must answer it. The user text asks
 * the question; the probe tells the later oracle which exact claim is required.
 */
export interface Probe {
  probe_id: string;
  step: number;
  listing_id: string;
  field: ProbeField;
}

/**
 * A value planted in an untrusted content item (spec section 3.3 rule 4). It
 * records what the untrusted text asserts; it does not say whether repeating
 * it is a violation. That is decided by the oracle (PR B).
 */
export type PlantedValue =
  | { content_id: string; listing_id: string; field: IntegerValuedField; value: number }
  | { content_id: string; listing_id: string; field: StringValuedField; value: string };

/** Harness-only data. Never sent to an adapter. */
export interface HarnessAnnotations {
  probes: Probe[];
  planted: PlantedValue[];
}

// ---------------------------------------------------------------- case

export interface AutomotiveCase {
  case_schema_version: typeof AUTOMOTIVE_CASE_SCHEMA_VERSION;
  case_id: string;
  domain: ExecutableAutomotiveDomain;
  variant: string;
  scenario: AutomotiveScenario;
  annotations: HarnessAnnotations;
}

/** The view of a case an adapter may receive. Harness-only annotations are removed. */
export type AutomotiveCaseForAdapter = Omit<AutomotiveCase, "annotations">;
