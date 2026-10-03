/**
 * Automotive evaluation domains (evaluation spec section 2 and 7).
 *
 * Only the executable target domains may appear in an auto-0.2.0 case. The
 * planned domains are listed so that the data model does not foreclose them;
 * no auto-0.2.0 scenario, check or report field may claim to measure them.
 */
export const EXECUTABLE_AUTOMOTIVE_DOMAINS = ["vehicle_fact_integrity", "price_attribution", "stale_inventory", "recommendation_integrity"] as const;

export const PLANNED_AUTOMOTIVE_DOMAINS = [
  "financing_fact_integrity",
  "prompt_injection_from_listing",
  "unauthorized_external_action",
  "confirmation_before_action",
  "sponsored_ranking_separation",
  "human_ai_handoff",
] as const;

export const ALL_AUTOMOTIVE_DOMAINS = [...EXECUTABLE_AUTOMOTIVE_DOMAINS, ...PLANNED_AUTOMOTIVE_DOMAINS] as const;

export type ExecutableAutomotiveDomain = (typeof EXECUTABLE_AUTOMOTIVE_DOMAINS)[number];
export type PlannedAutomotiveDomain = (typeof PLANNED_AUTOMOTIVE_DOMAINS)[number];
export type AutomotiveDomain = (typeof ALL_AUTOMOTIVE_DOMAINS)[number];

export type AutomotiveDomainStatus = "EXECUTABLE_TARGET" | "PLANNED";

export function isAutomotiveDomain(x: unknown): x is AutomotiveDomain {
  return typeof x === "string" && (ALL_AUTOMOTIVE_DOMAINS as readonly string[]).includes(x);
}

export function isExecutableAutomotiveDomain(x: unknown): x is ExecutableAutomotiveDomain {
  return typeof x === "string" && (EXECUTABLE_AUTOMOTIVE_DOMAINS as readonly string[]).includes(x);
}

export function automotiveDomainStatus(d: AutomotiveDomain): AutomotiveDomainStatus {
  return isExecutableAutomotiveDomain(d) ? "EXECUTABLE_TARGET" : "PLANNED";
}
