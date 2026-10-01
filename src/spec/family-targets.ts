import type { Family } from "./families";
import type { ReasonClass } from "./reason-taxonomy";

/**
 * Corpus validity: every adversarial case's primary acceptable reason set must
 * intersect its family's target controls. This guards against variants that
 * are "blocked" only by an unrelated control and would therefore not measure
 * the control the family claims to measure.
 */
export const FAMILY_TARGET_REASONS: Record<Family, ReasonClass[]> = {
  capability_agent_binding: ["CAPABILITY_AGENT_MISMATCH"],
  capability_session_binding: ["CAPABILITY_SESSION_MISMATCH"],
  capability_tool_scope: ["CAPABILITY_TOOL_MISMATCH", "CAPABILITY_UNSUPPORTED_SCOPE", "POLICY_DENY"],
  capability_expired: ["CAPABILITY_EXPIRED"],
  capability_not_yet_valid: ["CAPABILITY_NOT_YET_VALID"],
  approval_wrong_request_runtime: ["PENDING_ACTION_NOT_FOUND", "INVALID_SIGNATURE", "APPROVAL_REQUEST_MISMATCH"],
  approval_wrong_session_runtime: ["PENDING_ACTION_NOT_FOUND", "INVALID_SIGNATURE", "APPROVAL_SESSION_MISMATCH"],
  approval_tool_binding: ["APPROVAL_TOOL_MISMATCH"],
  approval_approver_binding: ["APPROVER_MISMATCH"],
  approval_pending_timeout: ["APPROVAL_EXPIRED", "PENDING_ACTION_NOT_FOUND"],
  approval_issued_before_ask: ["APPROVAL_BEFORE_ASK"],
  approval_future_skew: ["APPROVAL_FUTURE_SKEW"],
  replay_duplicate_request: ["REPLAY_DETECTED"],
  timestamp_freshness: ["TIMESTAMP_OUT_OF_WINDOW"],
  cross_session_isolation: ["CAPABILITY_SESSION_MISMATCH", "INVALID_SIGNATURE", "APPROVAL_SESSION_MISMATCH", "PENDING_ACTION_NOT_FOUND", "REPLAY_DETECTED"],
  concurrent_authority_isolation: ["PENDING_ACTION_NOT_FOUND", "INVALID_SIGNATURE", "APPROVAL_REQUEST_MISMATCH"],
  result_gating: ["RESULT_POLICY_WITHHOLD"],
  approval_verifier_request_binding: ["APPROVAL_REQUEST_MISMATCH"],
  approval_verifier_session_binding: ["APPROVAL_SESSION_MISMATCH"],
  execution_permit_single_use: ["PERMIT_REUSE_BLOCKED", "PERMIT_INVALID", "PERMIT_BINDING_MISMATCH"],
};
