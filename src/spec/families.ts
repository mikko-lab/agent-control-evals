import type { MeasuredBoundary } from "./boundaries";

/**
 * Evaluation families. In v0.1 every family corresponds to exactly one row of
 * the control matrix, so "per family" metrics are "per control" metrics.
 */
export const RUNTIME_FAMILIES = [
  "capability_agent_binding",
  "capability_session_binding",
  "capability_tool_scope",
  "capability_expired",
  "capability_not_yet_valid",
  "approval_wrong_request_runtime",
  "approval_wrong_session_runtime",
  "approval_tool_binding",
  "approval_approver_binding",
  "approval_pending_timeout",
  "approval_issued_before_ask",
  "approval_future_skew",
  "replay_duplicate_request",
  "timestamp_freshness",
  "cross_session_isolation",
  "concurrent_authority_isolation",
  "result_gating",
] as const;

export const COMPONENT_FAMILIES = [
  "approval_verifier_request_binding",
  "approval_verifier_session_binding",
  "execution_permit_single_use",
] as const;

export type RuntimeFamily = (typeof RUNTIME_FAMILIES)[number];
export type ComponentFamily = (typeof COMPONENT_FAMILIES)[number];
export type Family = RuntimeFamily | ComponentFamily;

export const ALL_FAMILIES: readonly Family[] = [...RUNTIME_FAMILIES, ...COMPONENT_FAMILIES];

export function boundaryOfFamily(f: Family): MeasuredBoundary {
  if ((RUNTIME_FAMILIES as readonly string[]).includes(f)) return "runtime";
  if ((COMPONENT_FAMILIES as readonly string[]).includes(f)) return "component";
  throw new Error(`unknown family ${f}`);
}

export function isFamily(x: string): x is Family {
  return (ALL_FAMILIES as readonly string[]).includes(x);
}
