import type { EvaluationBoundary } from "./boundaries";
import type { Family } from "./families";

export interface ControlEntry {
  control: string;
  evaluation_boundary: EvaluationBoundary;
  status: "measured" | "N/A";
  family: Family | null;
  /** Public entry point(s) through which the control is exercised (runtime) or the component under test. */
  entry_points: string[];
  reason?: string;
}

/**
 * v0.1 control matrix (work order section 4). This is data, rendered into the
 * report verbatim. N/A rows never contribute to any denominator, score, bound
 * or mutation kill.
 */
export const CONTROL_MATRIX: readonly ControlEntry[] = [
  { control: "capability_agent_binding", evaluation_boundary: "runtime", status: "measured", family: "capability_agent_binding", entry_points: ["GuardedExecutor.process"] },
  { control: "capability_session_binding", evaluation_boundary: "runtime", status: "measured", family: "capability_session_binding", entry_points: ["GuardedExecutor.process"] },
  { control: "capability_tool_scope", evaluation_boundary: "runtime", status: "measured", family: "capability_tool_scope", entry_points: ["GuardedExecutor.process"] },
  { control: "capability_expired", evaluation_boundary: "runtime", status: "measured", family: "capability_expired", entry_points: ["GuardedExecutor.process"] },
  { control: "capability_not_yet_valid", evaluation_boundary: "runtime", status: "measured", family: "capability_not_yet_valid", entry_points: ["GuardedExecutor.process"] },
  { control: "approval_request_binding_verifier_invariant", evaluation_boundary: "component", status: "measured", family: "approval_verifier_request_binding", entry_points: ["ApprovalGrantVerifier.verifyV2"] },
  { control: "approval_session_binding_verifier_invariant", evaluation_boundary: "component", status: "measured", family: "approval_verifier_session_binding", entry_points: ["ApprovalGrantVerifier.verifyV2"] },
  { control: "wrong_request_approval_runtime_rejection", evaluation_boundary: "runtime", status: "measured", family: "approval_wrong_request_runtime", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "wrong_session_approval_runtime_rejection", evaluation_boundary: "runtime", status: "measured", family: "approval_wrong_session_runtime", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "approval_tool_binding", evaluation_boundary: "runtime", status: "measured", family: "approval_tool_binding", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "approval_approver_binding", evaluation_boundary: "runtime", status: "measured", family: "approval_approver_binding", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "approval_pending_timeout", evaluation_boundary: "runtime", status: "measured", family: "approval_pending_timeout", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "approval_issued_at_before_ask_creation", evaluation_boundary: "runtime", status: "measured", family: "approval_issued_before_ask", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "approval_excessive_future_issued_at", evaluation_boundary: "runtime", status: "measured", family: "approval_future_skew", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "execution_permit_single_use", evaluation_boundary: "component", status: "measured", family: "execution_permit_single_use", entry_points: ["ExecutionGate.mintPermit", "ExecutionGate.execute"] },
  { control: "replay_duplicate_request", evaluation_boundary: "runtime", status: "measured", family: "replay_duplicate_request", entry_points: ["GuardedExecutor.process", "GuardedExecutor.clearSession"] },
  { control: "timestamp_freshness", evaluation_boundary: "runtime", status: "measured", family: "timestamp_freshness", entry_points: ["GuardedExecutor.process"] },
  { control: "cross_session_authority_isolation", evaluation_boundary: "runtime", status: "measured", family: "cross_session_isolation", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval", "GuardedExecutor.clearSession"] },
  { control: "concurrent_authority_isolation", evaluation_boundary: "runtime", status: "measured", family: "concurrent_authority_isolation", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "result_gating_withholding", evaluation_boundary: "runtime", status: "measured", family: "result_gating", entry_points: ["GuardedExecutor.process", "GuardedExecutor.resolveApproval"] },
  { control: "tenant_isolation", evaluation_boundary: "N/A", status: "N/A", family: null, entry_points: [], reason: "not modelled by pinned ACS v0.4.0 (tenant_id is a reserved wire field with no isolation rules)" },
  { control: "production_latency_throughput", evaluation_boundary: "N/A", status: "N/A", family: null, entry_points: [], reason: "not a v0.1 evaluation target" },
];
