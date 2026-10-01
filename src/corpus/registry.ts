import type { Family } from "../spec/families";
import type { VariantDef } from "./variant";
import { capabilityAgentBinding, capabilityExpired, capabilityNotYetValid, capabilitySessionBinding, capabilityToolScope } from "./families-runtime-capability";
import {
  approvalApproverBinding,
  approvalFutureSkew,
  approvalIssuedBeforeAsk,
  approvalPendingTimeout,
  approvalToolBinding,
  approvalWrongRequestRuntime,
  approvalWrongSessionRuntime,
} from "./families-runtime-approval";
import { concurrentAuthorityIsolation, crossSessionIsolation, replayDuplicateRequest, resultGating, timestampFreshness } from "./families-runtime-other";
import { approvalVerifierRequestBinding, approvalVerifierSessionBinding, executionPermitSingleUse } from "./families-component";

export const FAMILY_VARIANTS: Record<Family, VariantDef[]> = {
  capability_agent_binding: capabilityAgentBinding,
  capability_session_binding: capabilitySessionBinding,
  capability_tool_scope: capabilityToolScope,
  capability_expired: capabilityExpired,
  capability_not_yet_valid: capabilityNotYetValid,
  approval_wrong_request_runtime: approvalWrongRequestRuntime,
  approval_wrong_session_runtime: approvalWrongSessionRuntime,
  approval_tool_binding: approvalToolBinding,
  approval_approver_binding: approvalApproverBinding,
  approval_pending_timeout: approvalPendingTimeout,
  approval_issued_before_ask: approvalIssuedBeforeAsk,
  approval_future_skew: approvalFutureSkew,
  replay_duplicate_request: replayDuplicateRequest,
  timestamp_freshness: timestampFreshness,
  cross_session_isolation: crossSessionIsolation,
  concurrent_authority_isolation: concurrentAuthorityIsolation,
  result_gating: resultGating,
  approval_verifier_request_binding: approvalVerifierRequestBinding,
  approval_verifier_session_binding: approvalVerifierSessionBinding,
  execution_permit_single_use: executionPermitSingleUse,
};
