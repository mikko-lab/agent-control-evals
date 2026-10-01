/**
 * Normalised outcome vocabularies, one per stage. Component stages have their
 * own vocabularies and are never forced into ALLOW/ASK/DENY.
 */
export const REQUEST_OUTCOMES = ["ALLOW", "ASK", "DENY"] as const;
export const APPROVAL_OUTCOMES = ["EXECUTE", "REJECT"] as const;
export const RESULT_OUTCOMES = ["DELIVER", "WITHHOLD"] as const;
export const VERIFIER_OUTCOMES = ["ACCEPT", "REJECT"] as const;
export const PERMIT_OUTCOMES = ["EXECUTE_ONCE", "REUSE_BLOCKED", "REUSE_ACCEPTED", "REJECT"] as const;

export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];
export type VerifierOutcome = (typeof VERIFIER_OUTCOMES)[number];
export type PermitOutcome = (typeof PERMIT_OUTCOMES)[number];

export type Stage = "request" | "approval" | "result" | "verifier" | "permit";

export const STAGE_OUTCOMES: Record<Stage, readonly string[]> = {
  request: REQUEST_OUTCOMES,
  approval: APPROVAL_OUTCOMES,
  result: RESULT_OUTCOMES,
  verifier: VERIFIER_OUTCOMES,
  permit: PERMIT_OUTCOMES,
};

/**
 * Permissiveness classification used by false-allow / false-deny metrics.
 * "permissive" = authority granted / data released; "restrictive" = blocked.
 * ASK is "escalation" and is neither: expected DENY -> actual ASK is an
 * unexpected escalation, not a false allow.
 */
export type Polarity = "permissive" | "restrictive" | "escalation";

export const OUTCOME_POLARITY: Record<Stage, Record<string, Polarity>> = {
  request: { ALLOW: "permissive", ASK: "escalation", DENY: "restrictive" },
  approval: { EXECUTE: "permissive", REJECT: "restrictive" },
  result: { DELIVER: "permissive", WITHHOLD: "restrictive" },
  verifier: { ACCEPT: "permissive", REJECT: "restrictive" },
  permit: { EXECUTE_ONCE: "permissive", REUSE_ACCEPTED: "permissive", REUSE_BLOCKED: "restrictive", REJECT: "restrictive" },
};
