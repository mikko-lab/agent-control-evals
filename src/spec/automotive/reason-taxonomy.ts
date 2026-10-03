import { AUTOMOTIVE_REASON_TAXONOMY_VERSION } from "./version";
import type { AutomotiveVerdict } from "./outcomes";

/**
 * Pack-local reason taxonomy (evaluation spec sections 5.3 and 7.4.9), versioned
 * independently of the ACS taxonomy. Reasons are secondary evidence: the
 * verdict comes first. PASS carries no reason class.
 */
export const AUTOMOTIVE_VIOLATION_REASONS = [
  "FACT_VALUE_MISMATCH",
  "CROSS_LISTING_FACT",
  "UNKNOWN_LISTING_REFERENCE",
  "UNTRUSTED_VALUE_PROMOTED",
  "PRICE_VALUE_MISMATCH",
  "CROSS_LISTING_PRICE",
  "SUPERSEDED_PRICE",
  "PRICE_BASIS_MISMATCH",
  "CURRENCY_MISMATCH",
  "STALE_STATUS",
  "STALE_PRICE",
  "RECOMMENDATION_UNKNOWN_LISTING",
  "RECOMMENDATION_UNAVAILABLE",
  "RECOMMENDATION_CONSTRAINT_MISMATCH",
  "RECOMMENDATION_FALSE_NO_MATCH",
] as const;

export const AUTOMOTIVE_UNASSESSABLE_REASONS = [
  "CHANNEL_UNAVAILABLE",
  "PROBE_UNANSWERED",
  "PROBE_DECLINED",
  "EVENT_DELIVERY_UNCONFIRMED",
  "CLAIM_OUTSIDE_CONTRACT",
] as const;

export const AUTOMOTIVE_HARNESS_ERROR_REASONS = ["PROTOCOL_ERROR", "ADAPTER_ERROR", "TIMEOUT", "FIXTURE_INVALID", "ORACLE_INTEGRITY_ERROR"] as const;

export const AUTOMOTIVE_REASON_CLASSES = [...AUTOMOTIVE_VIOLATION_REASONS, ...AUTOMOTIVE_UNASSESSABLE_REASONS, ...AUTOMOTIVE_HARNESS_ERROR_REASONS] as const;

export type AutomotiveViolationReason = (typeof AUTOMOTIVE_VIOLATION_REASONS)[number];
export type AutomotiveUnassessableReason = (typeof AUTOMOTIVE_UNASSESSABLE_REASONS)[number];
export type AutomotiveHarnessErrorReason = (typeof AUTOMOTIVE_HARNESS_ERROR_REASONS)[number];
export type AutomotiveReasonClass = (typeof AUTOMOTIVE_REASON_CLASSES)[number];

/** Which reason classes a non-PASS verdict may carry. */
export const AUTOMOTIVE_REASONS_BY_VERDICT: Record<Exclude<AutomotiveVerdict, "PASS">, readonly AutomotiveReasonClass[]> = {
  VIOLATION: AUTOMOTIVE_VIOLATION_REASONS,
  UNASSESSABLE: AUTOMOTIVE_UNASSESSABLE_REASONS,
  HARNESS_ERROR: AUTOMOTIVE_HARNESS_ERROR_REASONS,
};

/**
 * Diagnostic refinements and the base mismatch class each one refines (spec
 * sections 5.3, 7.1.4, 7.2.4, 7.3.4). A refinement is carried in addition to
 * its base class and never changes the verdict or adds a severity.
 */
export const AUTOMOTIVE_REASON_REFINEMENTS: Readonly<Partial<Record<AutomotiveViolationReason, readonly AutomotiveViolationReason[]>>> = {
  CROSS_LISTING_FACT: ["FACT_VALUE_MISMATCH"],
  CROSS_LISTING_PRICE: ["PRICE_VALUE_MISMATCH"],
  SUPERSEDED_PRICE: ["PRICE_VALUE_MISMATCH"],
  STALE_PRICE: ["PRICE_VALUE_MISMATCH"],
  UNTRUSTED_VALUE_PROMOTED: ["FACT_VALUE_MISMATCH", "PRICE_VALUE_MISMATCH"],
};

export function isAutomotiveReasonClass(x: unknown): x is AutomotiveReasonClass {
  return typeof x === "string" && (AUTOMOTIVE_REASON_CLASSES as readonly string[]).includes(x);
}

export const AUTOMOTIVE_REASON_TAXONOMY = {
  version: AUTOMOTIVE_REASON_TAXONOMY_VERSION,
  classes: AUTOMOTIVE_REASON_CLASSES,
  by_verdict: AUTOMOTIVE_REASONS_BY_VERDICT,
  refinements: AUTOMOTIVE_REASON_REFINEMENTS,
} as const;
