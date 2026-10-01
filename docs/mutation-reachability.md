# Mutation set v0.1: reachability

Source of truth: [`mutations/manifest.json`](../mutations/manifest.json). Patches: `mutations/<id>.patch`. Every patch targets only `acs-guardrail-demo@403d31593a0d57187df3f5e1ef3df6127baaefb9`, changes exactly one file inside one declared function, and is applied in a fresh disposable checkout. Mutants are never chained. `ace reachability` validates all of this statically against the pinned source; the mutation run supplies the dynamic evidence (witness cases).

## Rules

- A **runtime** mutant must have a documented path from a public runtime API (`GuardedExecutor.process`, `resolveApproval` or `clearSession`) to the mutated control. It may only be killed by runtime witness cases.
- A **component** mutant targets a control that exists in ACS but cannot purposefully be reached through the public runtime API. It carries a written runtime-unreachability argument and may only be killed by component witness cases. As supporting dynamic evidence, the mutation run also executes every runtime case against component mutants. If a component mutant changes **any** runtime outcome, the boundary classification is contradicted and the mutant is marked invalid (gate failure).
- A mutant that cannot be reached at its declared boundary is neither counted as surviving nor silently dropped. It is moved to the right boundary or marked out of scope. In v0.1 no mutant needed to be dropped.
- **Kill criteria:** a witness case must satisfy all four conditions. (1) The baseline ran it validly. (2) The baseline met its primary outcome assertion, *with an observed reason among the mutant's `exposed_reason_classes`*, so the baseline blocked it through the mutated control. (3) The mutant ran it validly. (4) The mutant violated the primary outcome assertion or an authority invariant. Patch, build, startup, protocol and adapter failures, random exceptions, and reason-only changes are never kills.

## Mutants

### Runtime boundary

#### M01-capability-agent-binding-bypass

- Family: `capability_agent_binding`
- Target: `src/capability-grant.ts`, `CapabilityGrantVerifier.verify`
- Description: CapabilityGrantVerifier.verify no longer rejects a capability whose signed agent_id differs from the authenticated request agent.
- Target invariant: A capability authorises only the agent it is bound to.
- Expected exposed invariant: Request with a validly signed capability for another agent must be DENY (CAPABILITY_AGENT_MISMATCH).
- Reachability path: `GuardedExecutor.process` → `CapabilityProvider.resolve (harness-owned)` → `CapabilityGrantVerifier.verify` → `agent_id binding check`
- Witness families: `capability_agent_binding`; exposed reason classes: `CAPABILITY_AGENT_MISMATCH`
- Patch SHA-256: `6afda8d4807951c0ac1b41a49a847389ae6957e48c1fe686fc585a7403ffa296`

#### M02-capability-session-binding-bypass

- Family: `capability_session_binding`
- Target: `src/capability-grant.ts`, `CapabilityGrantVerifier.verify`
- Description: CapabilityGrantVerifier.verify no longer rejects a capability bound to a different session.
- Target invariant: A capability authorises only the session it is bound to.
- Expected exposed invariant: Request presenting another session's capability must be DENY (CAPABILITY_SESSION_MISMATCH).
- Reachability path: `GuardedExecutor.process` → `CapabilityProvider.resolve (harness-owned)` → `CapabilityGrantVerifier.verify` → `session_id binding check`
- Witness families: `capability_session_binding`, `cross_session_isolation`; exposed reason classes: `CAPABILITY_SESSION_MISMATCH`
- Patch SHA-256: `9abe2f5f260f2da98bf479ade7cb44b774f3abd5fa08a841d4490e7c17dace2a`

#### M03-capability-tool-scope-bypass

- Family: `capability_tool_scope`
- Target: `src/capability-grant.ts`, `CapabilityGrantVerifier.verify`
- Description: CapabilityGrantVerifier.verify no longer requires the requested tool to be in allowed_tools.
- Target invariant: A capability authorises only tools listed exactly in allowed_tools.
- Expected exposed invariant: Request for a tool outside the capability scope must be DENY (CAPABILITY_TOOL_MISMATCH).
- Reachability path: `GuardedExecutor.process` → `CapabilityProvider.resolve (harness-owned)` → `CapabilityGrantVerifier.verify` → `allowed_tools exact-match check`
- Witness families: `capability_tool_scope`; exposed reason classes: `CAPABILITY_TOOL_MISMATCH`
- Patch SHA-256: `291bfe6cd51a14238f1875f099e72cdd8faccd8eeb4194d4f0803c951b822998`

#### M04-capability-expiry-bypass

- Family: `capability_expired`
- Target: `src/capability-grant.ts`, `CapabilityGrantVerifier.verify`
- Description: CapabilityGrantVerifier.verify no longer rejects capabilities with now >= expires_at.
- Target invariant: An expired capability authorises nothing.
- Expected exposed invariant: Request with an expired capability must be DENY (CAPABILITY_EXPIRED).
- Reachability path: `GuardedExecutor.process` → `CapabilityProvider.resolve (harness-owned)` → `CapabilityGrantVerifier.verify` → `expires_at check`
- Witness families: `capability_expired`; exposed reason classes: `CAPABILITY_EXPIRED`
- Patch SHA-256: `16ba46d0f38bbb56678235e4e482d6aaec70d6f94d1a8eebbee5b811dbff1eb9`

#### M05-capability-not-yet-valid-bypass

- Family: `capability_not_yet_valid`
- Target: `src/capability-grant.ts`, `CapabilityGrantVerifier.verify`
- Description: CapabilityGrantVerifier.verify no longer rejects capabilities with now < issued_at.
- Target invariant: A capability is not valid before issued_at.
- Expected exposed invariant: Request with a not-yet-valid capability must be DENY (CAPABILITY_NOT_YET_VALID).
- Reachability path: `GuardedExecutor.process` → `CapabilityProvider.resolve (harness-owned)` → `CapabilityGrantVerifier.verify` → `issued_at check`
- Witness families: `capability_not_yet_valid`; exposed reason classes: `CAPABILITY_NOT_YET_VALID`
- Patch SHA-256: `b1a73aff326925a5adbce5c3a34b2259d4032d21483d44cccecfbaf0384d77f7`

#### M06-approval-tool-binding-bypass

- Family: `approval_tool_binding`
- Target: `src/approval-verifier.ts`, `ApprovalGrantVerifier.verifyV2`
- Description: ApprovalGrantVerifier.verifyV2 no longer compares the signed tool with the pending action's tool.
- Target invariant: An approval authorises only the tool of the pending action it was issued for.
- Expected exposed invariant: Validly signed grant for a different tool must be REJECT and must not execute the pending action.
- Reachability path: `GuardedExecutor.process (ASK creates pending action)` → `GuardedExecutor.resolveApproval` → `pending lookup by grant (session_id, request_id)` → `ApprovalGrantVerifier.verifyV2 with trusted context from the pending action` → `tool binding check`
- Witness families: `approval_tool_binding`; exposed reason classes: `APPROVAL_TOOL_MISMATCH`
- Patch SHA-256: `89e5aae210bf522201bdfac7216d334bb311d9ec03dc8ed6459ef86bbfa5e26d`

#### M07-approval-approver-binding-bypass

- Family: `approval_approver_binding`
- Target: `src/approval-verifier.ts`, `ApprovalGrantVerifier.verifyV2`
- Description: ApprovalGrantVerifier.verifyV2 no longer compares the approver claim with the pending action's configured approver.
- Target invariant: Only the configured approver claim can resolve a pending action.
- Expected exposed invariant: Validly signed grant naming another approver must be REJECT.
- Reachability path: `GuardedExecutor.process (ASK creates pending action)` → `GuardedExecutor.resolveApproval` → `pending lookup by grant (session_id, request_id)` → `ApprovalGrantVerifier.verifyV2 with trusted context from the pending action` → `approver binding check`
- Witness families: `approval_approver_binding`; exposed reason classes: `APPROVER_MISMATCH`
- Patch SHA-256: `92c6ea86a70f51a00eea25c908eb5b80b60bf0d232048040098e112b9239fbbc`

#### M08-approval-pending-timeout-bypass

- Family: `approval_pending_timeout`
- Target: `src/guarded-executor.ts`, `GuardedExecutor.resolveApproval`
- Description: GuardedExecutor.resolveApproval no longer expires pending actions after ask_details.timeout_seconds.
- Target invariant: A pending action cannot be approved after its timeout.
- Expected exposed invariant: Approval after the pending timeout must be REJECT and must not execute.
- Reachability path: `GuardedExecutor.process (ASK creates pending action at clock t0)` → `evaluation clock advanced past timeout` → `GuardedExecutor.resolveApproval` → `elapsed > timeout check`
- Witness families: `approval_pending_timeout`; exposed reason classes: `APPROVAL_EXPIRED`
- Patch SHA-256: `368589405ba8d7b865cc2a8c3de6ab48cad4764099ece280a23ce3e822bc8120`

#### M09-approval-issued-before-ask-bypass

- Family: `approval_issued_before_ask`
- Target: `src/guarded-executor.ts`, `GuardedExecutor.resolveApproval`
- Description: GuardedExecutor.resolveApproval no longer rejects grants with issued_at before the ASK was created.
- Target invariant: An approval cannot predate the decision it approves.
- Expected exposed invariant: Grant with issued_at < ASK creation must be REJECT.
- Reachability path: `GuardedExecutor.process (ASK creates pending action)` → `GuardedExecutor.resolveApproval` → `issued_at >= createdAtMs check`
- Witness families: `approval_issued_before_ask`; exposed reason classes: `APPROVAL_BEFORE_ASK`
- Patch SHA-256: `45178e84c841c41f347bb3dd009fc6ca31abbbb4674d0cacbec77d6205677042`

#### M10-approval-future-skew-bypass

- Family: `approval_future_skew`
- Target: `src/guarded-executor.ts`, `GuardedExecutor.resolveApproval`
- Description: GuardedExecutor.resolveApproval no longer rejects grants issued too far in the future.
- Target invariant: Approval issued_at may not exceed now + approvalFutureSkewMs.
- Expected exposed invariant: Grant with excessive future issued_at must be REJECT.
- Reachability path: `GuardedExecutor.process (ASK creates pending action)` → `GuardedExecutor.resolveApproval` → `issued_at <= now + skew check`
- Witness families: `approval_future_skew`; exposed reason classes: `APPROVAL_FUTURE_SKEW`
- Patch SHA-256: `65ce72d12c9bff8b73b287491aec05a3fbbcbe661e793b4809d631ee41c7f1b9`

#### M11-replay-duplicate-bypass

- Family: `replay_duplicate_request`
- Target: `src/replay-guard.ts`, `ReplayGuard.check`
- Description: ReplayGuard.check no longer rejects a duplicate request_id within a session.
- Target invariant: A request_id is accepted at most once per session.
- Expected exposed invariant: Duplicate request in the same session must be DENY (REPLAY_DETECTED) and must not execute again.
- Reachability path: `GuardedExecutor.process` → `ReplayGuard.check` → `session-scoped duplicate check`
- Witness families: `replay_duplicate_request`, `cross_session_isolation`; exposed reason classes: `REPLAY_DETECTED`
- Patch SHA-256: `5f003b1f24ce2b3d305af68f2813680d0c09c2c96c8c2a0782aee16db1d826b9`

#### M12-timestamp-freshness-bypass

- Family: `timestamp_freshness`
- Target: `src/replay-guard.ts`, `ReplayGuard.check`
- Description: ReplayGuard.check no longer rejects timestamps outside the skew window.
- Target invariant: Requests outside the freshness window are rejected.
- Expected exposed invariant: Stale or future-skewed request must be DENY (TIMESTAMP_OUT_OF_WINDOW).
- Reachability path: `GuardedExecutor.process` → `ReplayGuard.check` → `skew window check`
- Witness families: `timestamp_freshness`; exposed reason classes: `TIMESTAMP_OUT_OF_WINDOW`
- Patch SHA-256: `b6d064cecbe38cd1eab81fa43e43ecd18a909e47201765e04647fe63fb2548b7`

#### M13-result-withhold-bypass

- Family: `result_gating`
- Target: `src/guarded-executor.ts`, `GuardedExecutor.processResultRequest`
- Description: GuardedExecutor ignores a Result Guardian DENY and delivers the raw tool output.
- Target invariant: Result-policy DENY withholds the raw output.
- Expected exposed invariant: Restricted output must be WITHHOLD, never DELIVER.
- Reachability path: `GuardedExecutor.process (ALLOW) or GuardedExecutor.resolveApproval (EXECUTE)` → `executeAndProcessResult` → `harness tool double returns corpus-defined restricted output` → `processResultRequest` → `Result Guardian deny branch`
- Witness families: `result_gating`; exposed reason classes: `RESULT_POLICY_WITHHOLD`
- Patch SHA-256: `21d56ca4d4afb9eec67d92950f5c8a88bbe5c8933801d7979e9d3d1dd6b6f55d`

#### M14-approval-consumption-deferred-past-async-boundary

- Family: `concurrent_authority_isolation`
- Target: `src/guarded-executor.ts`, `GuardedExecutor.resolveApproval`
- Description: Pending approval authority (pendingActions.delete(key)) is consumed only after the asynchronous execution path instead of synchronously before the first await.
- Target invariant: Duplicate concurrent approvals consume the pending authority at most once (consumption happens synchronously before the first asynchronous execution boundary).
- Expected exposed invariant: Two or more concurrent duplicate approvals execute the pending action exactly once.
- Reachability path: `GuardedExecutor.process (ASK creates pending action)` → `N concurrent GuardedExecutor.resolveApproval calls started without awaiting` → `each passes pending lookup + verifyV2 synchronously` → `pendingActions.delete(key) placement relative to await executeAndProcessResult`
- Witness families: `concurrent_authority_isolation`; exposed reason classes: `PENDING_ACTION_NOT_FOUND`
- Patch SHA-256: `7a12caf34375eadc3429cd8c376384174203caf99222f2708223ca1047deb1a4`

### Component boundary

#### M15-verifier-request-binding-bypass

- Family: `approval_verifier_request_binding`
- Target: `src/approval-verifier.ts`, `ApprovalGrantVerifier.verifyV2`
- Description: ApprovalGrantVerifier.verifyV2 no longer compares grant.request_id with the trusted expected request.
- Target invariant: verifyV2 rejects a grant whose request_id differs from the trusted context.
- Expected exposed invariant: verifyV2(grant for request A, context for request B) must REJECT.
- Reachability path: `ApprovalGrantVerifier.verifyV2 (direct component call)` → `request_id binding check`
- Why not runtime: GuardedExecutor.resolveApproval looks up the pending action by `${grant.session_id}:${grant.request_id}` and builds the trusted context from that pending action, whose ids were stored under the same key. Pending ids are schema-validated UUIDs (no ':'), so no (session_id, request_id) pair different from the pending one can produce the same key; the verifier's request comparison therefore always sees equal values on the public runtime path.
- Witness families: `approval_verifier_request_binding`; exposed reason classes: `APPROVAL_REQUEST_MISMATCH`
- Patch SHA-256: `e0f1dd2da74ba4f838f88e0b404362db7a9b0a6ac92315a3888f19893b323ebd`

#### M16-verifier-session-binding-bypass

- Family: `approval_verifier_session_binding`
- Target: `src/approval-verifier.ts`, `ApprovalGrantVerifier.verifyV2`
- Description: ApprovalGrantVerifier.verifyV2 no longer compares grant.session_id with the trusted expected session.
- Target invariant: verifyV2 rejects a grant whose session_id differs from the trusted context.
- Expected exposed invariant: verifyV2(grant for session A, context for session B) must REJECT.
- Reachability path: `ApprovalGrantVerifier.verifyV2 (direct component call)` → `session_id binding check`
- Why not runtime: Same as M15: the pending lookup key embeds grant.session_id, and the trusted expected session is read from the pending action stored under that key, so the runtime path cannot present differing session values to verifyV2.
- Witness families: `approval_verifier_session_binding`; exposed reason classes: `APPROVAL_SESSION_MISMATCH`
- Patch SHA-256: `9ed9cddd9d5c040bbaef192e0bba540b64ce74a04ba25dca77434b4327a1cb67`

#### M17-execution-permit-reuse-bypass

- Family: `execution_permit_single_use`
- Target: `src/execution-gate.ts`, `ExecutionGate.execute`
- Description: ExecutionGate.execute no longer removes a permit from #activePermits when it is used.
- Target invariant: An execution permit authorises at most one execution.
- Expected exposed invariant: Presenting the same minted permit twice executes the tool at most once.
- Reachability path: `ExecutionGate.mintPermit (harness-held authority symbol)` → `ExecutionGate.execute x N with the same permit` → `#activePermits.delete(permit)`
- Why not runtime: GuardedExecutor mints a fresh permit inside executeAndProcessResult for every execution, passes it to ExecutionGate.execute exactly once and never exposes the permit or the private #permitAuthority symbol through its public API, so no public runtime call can present a used permit again.
- Witness families: `execution_permit_single_use`; exposed reason classes: `PERMIT_REUSE_BLOCKED`
- Patch SHA-256: `0960579ae2f98cb9501e7f9cae7b3f2a9789593cd5cffa43e710a796c7273637`

## Note on the concurrency mutant (M14)

In the pinned SUT, `resolveApproval` has no `await` before `this.pendingActions.delete(key)`. Pending lookup, `verifyV2`, the freshness and expiry checks, and the deletion therefore all run synchronously in the first call, before the first asynchronous boundary (`await executeAndProcessResult`, where the tool runs). A second concurrent call starts only after that and finds no pending action. M14 moves the deletion to after the awaited execution path. That breaks the real invariant, *consumption happens before the first asynchronous execution boundary*, without inventing a lock. Two or more concurrently started duplicate approvals then execute the action more than once (`executions > 1`). Sequential approvals are unaffected, so only the concurrency family can kill it.
