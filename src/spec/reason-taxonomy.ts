import { REASON_TAXONOMY_VERSION } from "../version";

/**
 * Harness-owned canonical reason taxonomy (versioned). Adapters map SUT
 * reason codes to these classes; the oracle and comparator only ever see
 * canonical classes. Reasons are secondary evidence; outcomes come first.
 */
export const REASON_CLASSES = [
  // request stage, fail-closed before policy
  "REQUEST_SCHEMA_INVALID",
  "REQUEST_SIGNATURE_INVALID",
  "REPLAY_DETECTED",
  "TIMESTAMP_OUT_OF_WINDOW",
  "CAPABILITY_MISSING",
  "CAPABILITY_INVALID_SIGNATURE",
  "CAPABILITY_MALFORMED",
  "CAPABILITY_UNSUPPORTED_SCOPE",
  "CAPABILITY_AGENT_MISMATCH",
  "CAPABILITY_SESSION_MISMATCH",
  "CAPABILITY_TOOL_MISMATCH",
  "CAPABILITY_EXPIRED",
  "CAPABILITY_NOT_YET_VALID",
  // request stage, policy
  "POLICY_ALLOW",
  "POLICY_ASK",
  "POLICY_DENY",
  // approval stage
  "PENDING_ACTION_NOT_FOUND",
  "APPROVAL_REQUEST_MISMATCH",
  "APPROVAL_SESSION_MISMATCH",
  "APPROVAL_TOOL_MISMATCH",
  "APPROVER_MISMATCH",
  "APPROVAL_EXPIRED",
  "APPROVAL_BEFORE_ASK",
  "APPROVAL_FUTURE_SKEW",
  "INVALID_SIGNATURE",
  "APPROVAL_MALFORMED",
  "APPROVAL_VERSION_REJECTED",
  "HUMAN_REJECTED",
  "APPROVAL_GRANTED",
  // result stage
  "RESULT_POLICY_DELIVER",
  "RESULT_POLICY_WITHHOLD",
  "CORRELATION_FAILURE",
  "RESULT_PATH_REJECTED",
  // component: execution gate
  "PERMIT_ACCEPTED",
  "PERMIT_REUSE_BLOCKED",
  "PERMIT_INVALID",
  "PERMIT_BINDING_MISMATCH",
  // component: approval verifier
  "APPROVAL_VERIFIED",
  // reserved: not emitted by the v0.1 ACS adapter (ACS has no dedicated cross-session code)
  "CROSS_SESSION_MISMATCH",
] as const;

export type ReasonClass = (typeof REASON_CLASSES)[number];

export function isReasonClass(x: unknown): x is ReasonClass {
  return typeof x === "string" && (REASON_CLASSES as readonly string[]).includes(x);
}

export const REASON_TAXONOMY = {
  version: REASON_TAXONOMY_VERSION,
  classes: REASON_CLASSES,
} as const;
