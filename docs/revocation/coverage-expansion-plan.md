# Coverage expansion plan — revocation track, `acs-guardrail-demo`

Status: **plan only**. This document changes no runtime, adapter, corpus, contract, profile or pin. It reviews the 13 `OUT_OF_SCOPE` cases and the 34 unassessed finish/seal decisions of the declared profile `acs-guardrail-demo-a682e44`, and recommends the first bounded implementation package.

Starting point (merged `main` @ `6db2502`, mikko-lab/agent-control-evals#13):

- Contract `revocation-0.4.0`. Runtime `mikko-lab/acs-guardrail-demo` @ `a682e4479dbccd1cd5f665f5d4879bd3dddb8b47` (`sut.revocation.lock.json`).
- Declared profile: 14 `IN_PROFILE` cases (all PASS), 13 `OUT_OF_SCOPE`, 34 finish/seal decisions not assessed. Supplement S1–S4 as declared. Exit 3. `contract_acceptance_passed: false`.
- Classification and reasons come from `profiles/revocation/acs-guardrail-demo-a682e44.profile.json` and `docs/revocation/runtime-adapter-compatibility.md` (§2, §3, §5, §7).

## 1. Ground rules for every expansion step

1. **The capability belongs to the runtime.** A case moves to `IN_PROFILE` only when the pinned runtime itself makes the decision and produces or prevents the effect through its public API or state. The harness never enumerates, tracks, withholds, mints or answers on the runtime's behalf. Examples of forbidden emulation are given per capability in §3.
2. **The adapter only maps.** Adapter changes may map contract identities and commands onto runtime identities and operations, and read new runtime state. They may not add a decision or an effect that the runtime did not make.
3. **Decision and effect stay separate.** The decision comes from the API answer of the step's own runtime call. The effect comes from runtime state (`sut_state`) or independent harness observation (`harness_observation`) in the step's barrier. Neither is derived from the other, and a disagreement is reported, not reconciled (compatibility spec §3.6, §4.1).
4. **One pin, one profile.** A runtime change is consumed only through a reviewed runtime release, a new `sut.revocation.lock.json`, and a new profile version. The classifier decides applicability from the capability rules alone. The golden profile is regenerated and reviewed. No CLI flag or observation file can change applicability.
5. **Every fix has a proving mutant.** Each capability lands with at least one typechecked runtime mutant that removes or weakens it, a fixed witness case, the expected findings and the expected exit, as for M1–M11. A capability without a detected mutant does not count as covered. The witness findings below are the ones each mutant must produce at least; the complete finding set and the exact exit (1, or 2 where the run also leaves incompleteness or an error, as for M1, M4, M7 and M10) are fixed when the witness is implemented.
6. **Nothing regresses.** The 14 current `IN_PROFILE` cases stay PASS, S1–S4 stay as declared, M1–M11 and AM1–AM10 stay detected, and the determinism and recorded-evaluation comparisons stay byte-identical.
7. **K stays K until §5 is done.** Moving every `OUT_OF_SCOPE` case into the profile does not make a contract pass. `contract_acceptance_passed` stays false while any finish/seal decision is unassessed (compatibility spec §2.3–§2.5).

## 2. Capability gaps

The 13 cases are blocked by nine unsupported capability classes, which fall into six runtime capability groups (G1–G6). A seventh group (G7) concerns only the K requirements (§5).

| Group | Unsupported classes | Runtime today (`a682e44`) | Blocks |
|---|---|---|---|
| **G1 Tenant scope** | `tenant_scope_revocation` | `parseRevocationTarget` accepts only `capability` and `session`. Grants carry no tenant. The runtime's own doc lists tenant scope as a non-goal (`tenant_id` is a reserved ACS wire field). | `tenant-multi-session-in-flight`, `tenant-isolation` |
| **G2 Descendant coverage** | `descendant_coverage` | `CapabilityGrantV1` has no parent link. `AuthorityRevocationRegistry.check()` matches one `capability_id`. The runtime doc lists ancestor/descendant scope as a non-goal. | `derived-in-flight-ancestor-revoked`, `derived-authority` (with G3) |
| **G3 Approval and permit lifecycle** | `initial_pending_authority`, `approve`, `issue` | Approval is per request: an ASK decision creates a pending action, and `resolveApproval()` approves **and** starts in one call. Permits are minted inside the start path (`ExecutionGate.mintPermit`, private `WeakSet`), and they are neither invocable nor observable. | `pending-approval`, `issue-after-cut`, `fresh-id-retry-unused-permit`, `approval-before-cut`, `derived-authority` |
| **G4 Single-use permit** | `single_use_permit` | A capability serves any number of requests. The per-request permit is consumed per request, not per authority. | `permit-single-use` |
| **G5 Execution addressability and identity** | `client_chosen_execution_id`, `operation_on_execution_unknown_to_runtime` | Execution ids (`exec-<n>`) are runtime-assigned. Commit, cancel acknowledgement and registration exist only on the `ExecutionContext` handed to the tool, so no caller can address an execution it was not given. | `execution-id-reuse`, `retry-after-revocation` |
| **G6 Runtime finish and explicit delivery** | `deliver_after_finish` (and the finish decisions of §5) | No finish operation: the tool function's own settlement ends the execution. The result is handed over when `process()` resolves, so there is no delivery request after finish. | `late-commit-after-terminal`, `cancel-is-not-rollback` |
| **G7 Runtime seal** | (K only) | No instance-level close or quiescence operation. | none of the 13; the seal decisions of all 27 cases (§5) |

## 3. Per-case plan (13 `OUT_OF_SCOPE` cases)

Notation: steps are corpus step indices. Expected decisions and effects are the oracle's, unchanged. "Runtime" or "adapter" means the change is needed there; "both" means a runtime capability plus its adapter mapping. Mutant numbers continue after M11 and are provisional. Each finding is the evaluator's code at the witness step. Every case below also keeps its finish/seal decisions as K until §5.

### 3.1 `pending-approval` (family `pending_approval`)

- **Tested property.** A revocation of a pending authority before approval prevents approval, permit issuance and start.
- **Current blocker.** Authority `a` starts `pending` (`initial_pending_authority`). `approve` at step 1 and `issue` at step 2 are not separate runtime operations.
- **Change.** Both, G3. The runtime needs an authority lifecycle: create a pending authority, then approve it and issue its permit as separate operations. Each is a decision fenced by revocation (stages `approval` and `issue`), and the resulting state is readable. The adapter maps `approve`/`issue` to those calls and reads the state.
- **Decision vs effect.** Decisions come from the return or `AuthorityRevokedError` of the runtime's approve and issue calls, and from `process()` for the start. Effects come from the runtime's authority record (`approved`, `permit issued`), not from the call's return, plus tool-double invocation for `execution_started`.
- **Acceptance.**
  - revoke ALLOW with `revocation_ack@0`;
  - approve, issue and start DENY;
  - no `approval_granted`, `permit_issued` or `execution_started` effect;
  - PASS under the new profile.
- **Proving mutant.** M12 "approval stage not fenced": the approve call skips the revocation check. Witness: `pending-approval` → `false_allow@1`, `unexpected_approval_granted@1`.
- **Forbidden emulation.** The adapter must not keep its own pending/approved state or deny `approve` because it saw the earlier revoke.

### 3.2 `issue-after-cut` (family `pending_approval`)

- **Tested property.** An approval granted before the cut does not let a permit be issued after it.
- **Current blocker.** Pending authority, plus `approve` at step 0 and `issue` at step 2 (G3).
- **Change.** Both, G3.
- **Decision vs effect.** As in §3.1. The `approval_granted@0` effect must be read from runtime state, and the absence of `permit_issued` must be read from the runtime's permit record after step 2.
- **Acceptance.**
  - approve ALLOW with `approval_granted@0`;
  - revoke ALLOW with `revocation_ack@1`;
  - issue and start DENY;
  - PASS.
- **Proving mutant.** M13 "issue stage not fenced". Witness: `issue-after-cut` → `false_allow@2`, `unexpected_permit_issued@2`.
- **Forbidden emulation.** No harness-minted permit (compatibility spec §3.5).

### 3.3 `fresh-id-retry-unused-permit` (family `issued_permit`)

- **Tested property.**
  - A start without an issued permit is denied (`permit_not_issued`).
  - After a cut, a retry with a fresh execution id is denied even though the issued permit is unused.
- **Current blocker.**
  - Pending authority.
  - Step 0: the start denial rests on `permit_not_issued` alone, which the runtime does not enforce.
  - `approve` at step 1 and `issue` at step 2.
- **Change.** Both, G3. The start path must require an issued, unconsumed permit of the authority.
- **Decision vs effect.** Start decisions come from `process()` (a new denial class for a missing permit). The effect is whether the tool double was invoked. `approval_granted@1` and `permit_issued@2` come from runtime state.
- **Acceptance.** The step 0 start is DENY without any revocation, and the step 4 retry is DENY. PASS.
- **Proving mutant.** M14 "start does not require an issued permit". Witness: `fresh-id-retry-unused-permit` → `false_allow@0`, `unexpected_execution_started@0`.

### 3.4 `tenant-multi-session-in-flight` (family `active_session`)

- **Tested property.** A tenant cut fences in-flight executions in every session of the tenant, `a/e1` (t1,s1) and `b/e2` (t1,s2), and leaves the other tenant's `c/e3` (t2,s1) committing and delivering.
- **Current blocker.** The revoke at step 3 has tenant scope (`tenant_scope_revocation`).
- **Change.** Both, G1.
  - **Runtime:**
    - a signed `tenant_id` in the grant, bound with the existing first-seen capability binding;
    - a `tenant` revocation target and receipt;
    - the tenant checked at every existing fence: request, approval, start, commit and delivery;
    - the cancellation signal sent to the tenant's running executions, as for the session scope.
  - **Adapter:** map contract tenant `t` to the grant's `tenant_id`; issue `revoke({scope: "tenant", tenant_id})`; map the receipt back. The runtime observation schema's `RuntimeTarget` and the identity mapping gain a tenant variant, as a versioned schema revision.
- **Decision vs effect.**
  - Revoke ALLOW comes from the receipt. Commit decisions come from `CommitReceipt` vs `CommitRejectedError` (new reason `tenant_revoked`), and the deliver decision from the public promise.
  - Effects come from `managedState` (key, value, version), the delivery nonce, `cancellation_acknowledged` and the terminal record, each read in the step barrier.
- **Acceptance.**
  - commits of `e1` and `e2` DENY with no `tool_commit`;
  - `c/e3` commit and deliver ALLOW with `tool_commit@6` and `output_delivery@7`;
  - terminals of `e1` and `e2` in window 3..11;
  - PASS.
- **Proving mutants.**
  - M15 "tenant not checked at the commit fence". Witness: this case → `false_allow@4`, `false_allow@5`, `unexpected_tool_commit@4`, `unexpected_tool_commit@5`.
  - M16 "tenant revocation over-reaches to every tenant" (matching on session name instead of tenant). Witness: `tenant-isolation` (§3.10) → `false_deny@2`, `missing_execution_started@2`.
- **Forbidden emulation.** The adapter must not translate a tenant revoke into one session revoke per known session. That is harness enumeration, and it would miss sessions that appear after the cut.
- **Fences this case does not reach.** Approval, delivery and the cancellation signal under tenant revocation are covered by supplement S7 and S9 (§7.3). The binding rules are in §7.5.

### 3.5 `late-commit-after-terminal` (family `in_flight_before_commit`)

- **Tested property.** After the execution is finished (terminal), neither a commit nor a delivery succeeds.
- **Current blocker.** `deliver` at step 4 comes after `finish` at step 2 (`deliver_after_finish`). The step 3 commit is already supported, because a retained context is fenced by `execution_terminal`.
- **Change.** Both, G6. The runtime needs an explicit delivery request that is separate from the tool function's return: the result is held until a `deliver(execution)` call, which is fenced like today's hand-over and is also answerable after finish. The adapter maps `deliver` to that call instead of fulfilling the tool's Promise.
- **Decision vs effect.** The deliver decision comes from the runtime's delivery answer (DENY with `execution_terminal` / `finish_requested`). The effect, `output_delivery`, is observed only if the consumer side receives `out(e)`, in a delivery sink the harness reads independently of the answer.
- **Acceptance.**
  - commit DENY at step 3 and deliver DENY at step 4;
  - no `tool_commit` and no `output_delivery`;
  - terminal in window 1..5;
  - PASS.
- **Proving mutant.** M17 "delivery fence ignores terminal". Witness: this case → `false_allow@4`, `unexpected_output_delivery@4`.
- **Forbidden emulation.** The harness must not withhold the nonce itself.

### 3.6 `retry-after-revocation` (family `in_flight_before_commit`)

- **Tested property.** After a cut, a fresh retry start is denied, and the retry label cannot commit.
- **Current blocker.** The commit of `a/retry` at step 4: the runtime never started `retry` (`operation_on_execution_unknown_to_runtime`).
- **Change.** Both, G5(b). The runtime needs an addressable operation surface, for example `commit({execution, authority/request}, key, value)`, that answers DENY `unbound_execution` for an execution unknown to the runtime or bound to another authority.
- **Decision vs effect.** The decision comes from that call's answer, and the effect from `managedState` (no key, no version growth).
- **Acceptance.** start DENY at step 3, commit DENY at step 4, no `execution_started(retry)` and no `tool_commit`. PASS.
- **Proving mutant.** M18 "addressed commit does not verify the binding" (it writes for an unknown id). Witness: this case → decision finding `false_allow@4`, with the write observed in `managedState`. With the current evaluator, a `tool_commit` of an execution that was never started is `causally_impossible` (HARNESS_ERROR, finding retained, exit 2). Whether a runtime-attested write to an unbound execution should instead be an effect finding is an evaluator question for the G5 eval PR.
- **Forbidden emulation.** The adapter must not answer DENY for a label it knows the runtime never started.
- **Design note.** Today's design is arguably stronger: an unaddressable execution cannot be misused at all. The contract, however, requires an assessable decision. The runtime owner must accept G5 as a design change before this is pursued (§6).

### 3.7 `cancel-is-not-rollback` (family `in_flight_after_commit`)

- **Tested property.**
  - A cancellation acknowledged after a commit does not undo the commit.
  - A delivery after finish is denied.
- **Current blocker.** `deliver` at step 5 comes after `finish` at step 4 (`deliver_after_finish`).
- **Change.** Both, G6, as in §3.5.
- **Decision vs effect.**
  - `cancel_ack` ALLOW comes from `acknowledgeCancellation()`. The effect is the `cancellation_acknowledged` flip.
  - The commit stays a historical effect: the key and value persist in `managedState`.
  - deliver DENY comes from the delivery answer, with no nonce in the sink.
- **Acceptance.**
  - `tool_commit@1`, `revocation_ack@2` and `cancellation_ack@3`;
  - deliver DENY at step 5;
  - terminal in window 2..6;
  - the commit's key and value still present at seal;
  - PASS.
- **Proving mutants.**
  - M19 "delivery after finish allowed". Witness: this case → `false_allow@5`, `unexpected_output_delivery@5`.
  - **Open point.** A runtime that rolls the commit back at cancellation removes a fact from the probe log. Today that is a log regression (`sequence_inconsistent`, HARNESS_ERROR, exit 2), not an effect finding. Whether a rollback should become an explicit contract finding is a contract question for a later version, not part of this plan. Until then a rollback mutant is detected only as exit 2.

### 3.8 `derived-authority` (family `descendant_scope`)

- **Tested property.** An ancestor's cut covers an issued child, whose start is denied, and a pending grandchild, whose approve and issue are denied.
- **Current blocker.**
  - Revoke at step 0: `descendant_coverage`.
  - Pending grandchild `pending-child`: `initial_pending_authority`.
  - `approve` at step 2 and `issue` at step 3.
- **Change.** Both, G2 + G3.
  - **Runtime:** a signed parent link (delegated grant naming its parent capability), bound with the existing first-seen binding so it cannot be rewritten. Every fence checks the whole ancestry. Cancellation fans out to running descendants. The authority lifecycle comes from G3.
  - **Adapter:** map each contract `parent` link to the grant's parent; the rest as in G3.
- **Decision vs effect.** As in §3.1 (approve and issue) and §3.9 (start under a revoked ancestor).
- **Acceptance.**
  - revoke ALLOW with `revocation_ack@0`;
  - start, approve and issue DENY;
  - no `execution_started`, `approval_granted` or `permit_issued`;
  - PASS.
- **Proving mutant.** M20 "ancestry not walked at request and start". Its package-1 witness is supplement S5 (§7.4), because this case needs G3 and stays `OUT_OF_SCOPE` after package 1. Once G3 lands, this case becomes a second witness → `false_allow@1`, `unexpected_execution_started@1`.
- **Forbidden emulation.** The adapter must not revoke each descendant capability separately.

### 3.9 `derived-in-flight-ancestor-revoked` (family `descendant_scope`)

- **Tested property.** An ancestor's cut fences an in-flight child execution's commit.
- **Current blocker.** The revoke at step 1 must cover `child` (`descendant_coverage`).
- **Change.** Both, G2 only.
- **Decision vs effect.**
  - The revoke receipt is the decision, and `revocation_ack@1` comes from the same receipt.
  - The commit decision comes from `CommitReceipt` vs `CommitRejectedError` (new reason, e.g. `ancestor_revoked`). The effect comes from `managedState`.
  - The terminal comes from the execution record and `terminals()`.
- **Acceptance.**
  - commit DENY at step 2 with no `tool_commit`;
  - terminal of `e2` in window 1..4;
  - PASS.
- **Proving mutant.** M21 "ancestry not walked at the commit fence". Witness: this case → `false_allow@2`, `unexpected_tool_commit@2`.
- **Fences this case does not reach.** Approval, delivery and the cancellation signal under ancestor revocation, and over-reach, are covered by supplement S8 and S10 and by `sibling-isolation` (§7.3).

### 3.10 `tenant-isolation` (family `scope_isolation`)

- **Tested property.**
  - A tenant cut does not reach another tenant, even where the session names coincide: `a` is (t1,s1) and `other` is (t2,s1).
  - The covered tenant's start is denied.
- **Current blocker.** The revoke at step 0 has tenant scope.
- **Change.** Both, G1, as in §3.4. The identity mapping already gives (t1,s1) and (t2,s1) distinct runtime session ids. The grant's `tenant_id` must be signed, so that the two sessions cannot be confused through the tenant.
- **Decision vs effect.** As in §3.4. `execution_started` comes from tool-double invocation, attributed from the runtime binding.
- **Acceptance.**
  - start of `a/e1` DENY;
  - `other/e2` start, commit and deliver ALLOW with `execution_started@2`, `tool_commit@3` and `output_delivery@4`;
  - terminal in window 5..7;
  - PASS.
- **Proving mutants.**
  - M16 (over-reach), see §3.4.
  - M22 "tenant not checked at start". Witness: this case → `false_allow@1`, `unexpected_execution_started@1`.

### 3.11 `execution-id-reuse` (family `identity`)

- **Tested property.** Another authority can neither take over an execution id that is in use nor commit to it.
- **Current blocker.**
  - The start of `b/e1` at step 1 (`client_chosen_execution_id`): the runtime assigns ids itself.
  - The commit of `b/e1` at step 2 (`operation_on_execution_unknown_to_runtime`).
- **Change.** Both, G5(a) + G5(b).
  - **Runtime:** accept a caller-supplied execution key on the request, bind it to the authority on the first start, and DENY `execution_id_in_use` for another authority. Plus the addressed operation surface from §3.6.
  - **Adapter:** pass the contract label as the key, and keep the label → `execution_id` mapping from runtime-issued values.
- **Decision vs effect.**
  - The start decision comes from `process()`, and the effect from tool-double invocation attributed from the runtime binding.
  - The commit decision comes from the addressed call, and the effect from `managedState`.
- **Acceptance.**
  - `b/e1` start DENY with no second `execution_started`;
  - commit DENY at step 2;
  - `a/e1` commit ALLOW with `tool_commit@4`;
  - terminal in window 5..6;
  - PASS.
- **Proving mutants.**
  - M23 "execution key uniqueness not enforced". Witness: this case → `false_allow@1`, `unexpected_execution_started@1`.
  - M18 (binding not verified) also applies at step 2.

### 3.12 `permit-single-use` (family `control`)

- **Tested property.** One issued permit allows one start. A retry with a fresh id is denied (`permit_consumed`) without any revocation.
- **Current blocker.** The step 1 denial rests on `permit_consumed` alone (`single_use_permit`).
- **Change.** Both, G4. The runtime records consumption of the authority's permit at start and denies a second start. Either it is the G3 permit, or, standalone, a signed single-use grant option that is enforced and observable. The adapter maps it and reads the consumption state.
- **Decision vs effect.** The decision comes from `process()` (a new error class), and the effect from the absence of tool-double invocation for `retry`. Consumption state is read from the runtime, never tracked by the harness.
- **Acceptance.**
  - `retry` start DENY;
  - `e1` commit and deliver ALLOW with `tool_commit@2` and `output_delivery@3`;
  - terminal in window 4..6;
  - PASS.
- **Proving mutant.** M24 "consumption not recorded". Witness: this case → `false_allow@1`, `unexpected_execution_started@1`.
- **Forbidden emulation.** The adapter must not refuse the second start itself.

### 3.13 `approval-before-cut` (family `control`)

- **Tested property.** Control case: the full lifecycle (approve → issue → start → commit → deliver → finish) is allowed before the cut, and a later revocation does not retroactively erase approval, permit or effects.
- **Current blocker.** Pending authority, `approve` at step 0 and `issue` at step 1 (G3).
- **Change.** Both, G3.
- **Decision vs effect.** As in §3.1–§3.3, with all decisions ALLOW. The effects are read from runtime state.
- **Acceptance.**
  - all expected effects observed: `approval_granted@0`, `permit_issued@1`, `execution_started@2`, `tool_commit@3`, `output_delivery@4`, the terminal in window 5..7 and `revocation_ack@6`;
  - no state regression after step 6;
  - PASS.
- **Proving mutant.** M25 "approval over-fenced" (issue denied after any approval). Witness: this case → `false_deny@1`, `missing_permit_issued@1`. This is the control that catches an over-blocking fix of M12–M14.

## 4. Summary table

| Case | Group | Change | Proving mutant(s) |
|---|---|---|---|
| `pending-approval` | G3 | both | M12 |
| `issue-after-cut` | G3 | both | M13 |
| `fresh-id-retry-unused-permit` | G3 | both | M14 |
| `tenant-multi-session-in-flight` | G1 | both | M15, M16; fence matrix §7.3 |
| `late-commit-after-terminal` | G6 | both | M17 |
| `retry-after-revocation` | G5(b) | both | M18 |
| `cancel-is-not-rollback` | G6 | both | M19 (rollback: open point §3.7) |
| `derived-authority` | G2 + G3 | both | M20 (package-1 witness: supplement S5) |
| `derived-in-flight-ancestor-revoked` | G2 | both | M21; fence matrix §7.3 |
| `tenant-isolation` | G1 | both | M16, M22; fence matrix §7.3 |
| `execution-id-reuse` | G5(a) + G5(b) | both | M23, M18 |
| `permit-single-use` | G4 (G3 if the permit object is shared) | both | M24 |
| `approval-before-cut` | G3 | both | M25 |

No case can be moved by an adapter change alone. Every blocker is a missing runtime capability. The adapter work is the mapping and the observation of new runtime state.

## 5. The finish/seal decisions (K), separate from the 13 cases

The K requirements are a different gap from the 13 cases. Moving all 13 cases into the profile leaves every K requirement unassessed, and **skipping them still blocks the whole contract acceptance**: `contract_acceptance_passed` requires `not_assessed_requirements == 0` and full-contract mode (compatibility spec §2.4, §2.5).

**Count.** 34 K requirements in the 14 `IN_PROFILE` cases (the reported `not_assessed_requirements`), plus 33 in the 13 `OUT_OF_SCOPE` cases (67 in all 27 cases):

| | `IN_PROFILE` | `OUT_OF_SCOPE` |
|---|---|---|
| `finish` ALLOW (bound execution; idempotent close, also after terminal) | 12 | 11 |
| `finish` DENY `unbound_execution` (execution never started, or another authority's) | 8 | 9 |
| `seal` ALLOW | 14 | 13 |
| Total | 34 | 33 |

**Why they are not assessed today.** `finish` and `seal` are harness commands: `finish` releases the registered-work lock, and `seal` is the final quiescence check. The runtime makes no decision for either, and the adapter must not report one (AM2).

**What would make them assessable (runtime capabilities):**

- **G6 finish:** a runtime `finish(execution, authority)` operation.
  - It is an idempotent close/await request that answers ALLOW for an execution bound to that authority, also after its terminal.
  - It closes the commit, delivery and cancel-acknowledgement fences with reason `finish_requested`.
  - It never creates a second terminal.
- **G5(b) addressability:** needed for the 17 `finish` DENY requirements. The runtime must answer DENY `unbound_execution` for an execution it never started or that belongs to another authority, which needs the addressed operation surface of §3.6.
- **G7 seal:** a runtime close/quiescence operation with a decision (ALLOW), returning a receipt that lists non-terminal executions and closing the instance to new requests.

**Proving mutants (provisional):**

| Mutant | Witness | Expected result |
|---|---|---|
| K1 "finish does not close the commit fence" | a new supplement case: start, finish, then commit, with no revocation | `false_allow` on the commit after finish |
| K2 "finish answers ALLOW for an unbound execution" | `cut-before-start` | `false_allow@2` |
| K3 "seal answers DENY while executions are terminal" | any case | `false_deny` at the seal step |

**Order.** The K work depends on G5(b) and G6 and should follow them. Until then, every report must keep stating the K reduction, and the declared-profile mode must stay unable to reach exit 0.

**Not a shortcut.** Reclassifying finish/seal as non-SUT steps in a later contract version would be a contract change. It would not turn a `revocation-0.4.0` declared-profile run into a contract pass, and it is outside this plan.

## 6. Dependencies, effort and safety value

| Group | Runtime effort | Adapter effort | Depends on | Cases unlocked | Safety value |
|---|---|---|---|---|---|
| G1 tenant scope | S–M: signed grant field, target, fence check, receipt, cancellation fan-out | S: identity and target mapping, versioned schema variant | none | 2 | **High.** A tenant-wide kill switch that today does not exist. Without it, a tenant cut is impossible or must be approximated session by session. |
| G2 descendant coverage | M: signed delegation link, ancestry walk at every fence, binding, cancellation fan-out | S: parent mapping | none | 1 (2 with G3) | **High.** Delegated authority that survives its ancestor's revocation is a privilege-retention path. |
| G3 approval/permit lifecycle | L: new authority lifecycle, two fenced operations, observable state, start requires an issued permit | M: two new commands, two new effect sources | none | 4 (5 with G2) | Medium–high. Fences approval and issuance, not only start. |
| G4 single-use permit | S–M standalone, S after G3 | S | G3 preferred | 1 | Medium. The runtime already single-uses each request's permit and has a replay guard. |
| G5 addressability/identity | M–L: public operation surface by execution key with binding checks; a design change against the current unaddressable-context model | M | runtime owner's design decision | 2, plus finish DENY (K) | Medium. It adds an attack surface that must be fenced, and the current design already prevents the misuse by construction. |
| G6 finish + explicit delivery | L: delivery model change (held result, explicit deliver), finish operation | M: construction changes for `deliver`/`finish` | G5(b) for finish DENY | 2, plus finish (K) | Medium. It closes fences at finish, but the current terminal fence already denies post-terminal commits. |
| G7 seal | S–M | S | none (G6 for meaningful quiescence) | K only | Low for runtime safety; required for contract acceptance. |

## 7. Recommendation: first bounded package

**Package 1 — revocation reach: G1 tenant scope, then G2 descendant coverage.**

### 7.1 Why this package first

- **Safety benefit.** Both close the most serious class of gap the contract defines: a revocation that does not reach authority it covers, so that start, commit and delivery stay allowed after the cut (`false_allow` plus unexpected effects). G3–G7 refine *when* and *where* fences apply. G1/G2 decide *whether* the cut reaches the authority at all.
- **Dependencies.** Neither depends on another group. Both extend the one existing check (`AuthorityRevocationRegistry.check()` at the existing request, approval, start, commit and delivery fences) and the existing cancellation fan-out in `revoke()`. Neither needs a new operation type or a change to the registered-work construction, and the evaluator semantics are unchanged.
- **Effort.**
  - **Runtime:** small to medium. It covers a new grant version, target parsing, the registry, the execution binding, chain verification, the cancellation fan-out and the runtime's own tests.
  - **Adapter:** mapping (tenant and parent identity, the issuer-signed chain, the tenant target and receipt) plus a versioned schema variant for the tenant target.
- **Corpus coverage.** 14 → 17 `IN_PROFILE`: `tenant-multi-session-in-flight`, `tenant-isolation` and `derived-in-flight-ancestor-revoked`. `derived-authority` still needs G3 and stays `OUT_OF_SCOPE`, so corpus coverage is **17/27**.

### 7.2 Three kinds of evidence

The package gate keeps three kinds of evidence apart. Only the first counts toward corpus coverage.

| Evidence | Where it lives | What it can show | What it counts toward |
|---|---|---|---|
| **Corpus** | The 17 `IN_PROFILE` cases, evaluated against the oracle | Contract decisions and effects through the runtime's public API and state | `corpus_coverage` 17/27, `profile_acceptance_passed` |
| **Supplement** | New cases S5–S10 in the profile's supplement file (golden-hashed, own expectations, own section of the report) | Runtime-specific checks in contract vocabulary for fences the corpus cases do not reach | `supplement_acceptance_passed` only; never corpus coverage |
| **Runtime-own tests** | `acs-guardrail-demo` test suite, pinned through the lock's SUT baseline (suite and test counts) | Internal check points and input validation that the contract cannot express: individual check points that mask one another, grant and chain validation, binding conflicts | The lock's baseline verification; the runtime-test mutants of §7.6. Never the profile or supplement results |

### 7.3 Fence matrix

The three new corpus cases do not reach every fence:
- `tenant-multi-session-in-flight` covers the commit fence and the cross-tenant delivery (non-coverage).
- `tenant-isolation` covers the request fence and over-reach at start, commit and delivery.
- `derived-in-flight-ancestor-revoked` covers the commit fence.

The corpus does not reach the delivery fence and the cancellation signal under tenant or ancestor revocation, nor the approval fence. These get supplement witnesses (§7.4).

The start guard (`beforeInvoke`, stage `start`) is reachable only through a revocation that takes effect inside one `process()` call, between the request checks and the tool invocation. No contract step can place one there. Its evidence is a runtime-own test; corpus and supplement claim nothing about it.

Each runtime check point has its own runtime test, because:
- the request stage checks twice (before capability resolution and after verification);
- a start after the cut that passed the request checks, or an approval that passed the approval re-verification, would still be stopped by the start guard (`resolveApproval()` runs the same start path);
- delivery checks twice (early check in result processing and the hand-over);

and a mutant that removes only one of these check points is masked by the others at the contract level. The contract witnesses therefore show each fence as a whole. M20 and M22 remove the check at the request checks and the start guard together, and M26 and M34 remove it at the approval re-verification and the start guard together.

| Fence | Tenant revocation (G1) | Ancestor revocation (G2) |
|---|---|---|
| **Request** (`process()`; stage `request`) | **Corpus** `tenant-isolation` step 1: start DENY, no `execution_started`. Mutant **M22** "tenant not checked at request and start" → `false_allow@1`, `unexpected_execution_started@1`. Runtime test for each of the two request check points: **M27a**. | **Supplement S5** `sup-ancestor-revoked-child-start` step 1: start DENY. Mutant **M20** "ancestry not walked at request and start" → `false_allow@1`, `unexpected_execution_started@1`. Runtime test per check point: **M27b**. |
| **Approval** (`resolveApproval()` re-verification; stage `approval`) | **Supplement S7** `sup-tenant-pending-approval-revoked`: approve DENY, tool never invoked. Mutant **M26** "tenant not checked at approval re-verification and start guard" → `false_allow@1`, `unexpected_execution_started@1`. The approval path also passes the start guard, so the approval check alone is masked; runtime test for it: **M26a**. | **Supplement S8** `sup-ancestor-pending-approval-revoked`: approve DENY. Mutant **M34** "ancestry not checked at approval re-verification and start guard" → `false_allow@1`, `unexpected_execution_started@1`. Runtime test for the approval check alone: **M34a**. |
| **Start guard** (`beforeInvoke`; stage `start`) | **Runtime-own test only** (revocation from an injected hook between the request checks and the invocation). Runtime-test mutant **M27c**. | **Runtime-own test only.** Runtime-test mutant **M27d**. |
| **Commit** (`ctx.commit()`) | **Corpus** `tenant-multi-session-in-flight` steps 4 and 5: DENY, no `tool_commit`. Mutant **M15** → `false_allow@4`, `false_allow@5`, `unexpected_tool_commit@4`, `unexpected_tool_commit@5`. **Supplement S9** step 2 is the non-vacuity commit before the cut. | **Corpus** `derived-in-flight-ancestor-revoked` step 2. Mutant **M21** → `false_allow@2`, `unexpected_tool_commit@2`. **Supplement S10** step 2 is the non-vacuity commit before the cut. |
| **Delivery** (early check and hand-over) | **Supplement S9** `sup-tenant-fences-in-flight` step 6: deliver DENY (withheld, `tenant_revoked`), no `output_delivery`. Mutant **M28** "tenant not checked at delivery" → `false_allow@6`, `unexpected_output_delivery@6`. Runtime test per check point: **M28a/M28b**. | **Supplement S10** `sup-ancestor-fences-in-flight` step 6: deliver DENY. Mutant **M35** → `false_allow@6`, `unexpected_output_delivery@6`. Runtime test per check point: **M35a/M35b**. |
| **Cancellation signal** (fan-out in `revoke()`) | **Supplement S9** step 5: `cancel_ack` ALLOW with `cancellation_ack@5`. The runtime returns `true` only when a cancellation was requested, so this observes the signal through the contract. Mutant **M29** "tenant revoke sends no cancellation" → `false_deny@5`, `missing_cancellation_ack@5`. Non-coverage of other tenants (no signal) is a runtime-own test, because the contract expects ALLOW for `cancel_ack` without a cancellation request, and this runtime's `false` is a declared unsupported class (§8). | **Supplement S10** step 5. Mutant **M36** "ancestor revoke sends no cancellation to descendants" → `false_deny@5`, `missing_cancellation_ack@5`. Non-coverage: runtime-own test. |
| **Over-reach** (the cut must not reach outside its scope) | **Corpus** `tenant-isolation` steps 2–4 (other tenant starts, commits, delivers) and `tenant-multi-session-in-flight` steps 6–7. **Supplement S9** step 7 (other tenant's delivery ALLOW). Mutant **M16** "tenant revocation over-reaches to every tenant" → `false_deny@2`, `missing_execution_started@2` in `tenant-isolation`. | **Corpus** `sibling-isolation`: with G2 its parent links are mapped (§7.5), so it tests that revoking `child` reaches neither its parent `a` nor its sibling. **Supplement S10** step 7 (unrelated authority's delivery ALLOW). Mutant **M37** "revocation propagates to parent or siblings" → `false_deny@2`, `missing_execution_started@2` in `sibling-isolation`. |
| **Non-vacuity** | The other tenant's ALLOWs above. | **Supplement S6** `sup-ancestor-control`: a child grant with a verified chain starts without any revocation (ALLOW). This shows that S5's DENY is caused by the ancestor revocation, not by a chain rejection. |

### 7.4 New supplement cases (package 1)

Each case has fresh state, its own expectations in contract vocabulary, a finish for every start, and one seal. Its finish/seal decisions are K, as for S1–S4. The ASK-based cases S7 and S8 reuse the setup of S1: a pending runtime approval created before step 0.

| Case | Authorities | Steps | Expected |
|---|---|---|---|
| S5 `sup-ancestor-revoked-child-start` | `a` issued; `child` issued, parent `a` (same tenant, same session) | revoke `a`; start `child/e2`; finish `child/e2`; seal | revoke ALLOW, `revocation_ack@0`; start DENY; no `execution_started`. No approve or issue operation. |
| S6 `sup-ancestor-control` | as S5 | start `child/e2`; finish `child/e2`; seal | start ALLOW, `execution_started@0`; terminal in window 1..2 |
| S7 `sup-tenant-pending-approval-revoked` | `a` in tenant `t1`; pending runtime approval of `a` | revoke tenant `t1`; approve `a`; finish `a/e1`; seal | revoke ALLOW, `revocation_ack@0`; approve DENY; no `execution_started` |
| S8 `sup-ancestor-pending-approval-revoked` | `a`; `child` with parent `a`; pending runtime approval of `child` | revoke `a`; approve `child`; finish `child/e2`; seal | revoke ALLOW; approve DENY; no `execution_started` |
| S9 `sup-tenant-fences-in-flight` | `a` (t1,s1); `b` (t2,s1), with distinct runtime sessions | 0 start `a/e1`; 1 start `b/e2`; 2 commit `a/e1`; 3 commit `b/e2`; 4 revoke tenant `t1`; 5 `cancel_ack a/e1`; 6 deliver `a/e1`; 7 deliver `b/e2`; 8 finish `a/e1`; 9 finish `b/e2`; 10 seal | starts and commits ALLOW (`tool_commit@2`, `tool_commit@3`); `revocation_ack@4`; `cancel_ack` ALLOW, `cancellation_ack@5`; deliver `a` DENY (no `output_delivery`); deliver `b` ALLOW, `output_delivery@7`; terminal `e1` in 4..10, `e2` in 9..10 |
| S10 `sup-ancestor-fences-in-flight` | `a`; `child` with parent `a`; `peer` without a parent (same tenant and session) | 0 start `child/e2`; 1 start `peer/e3`; 2 commit `child/e2`; 3 commit `peer/e3`; 4 revoke `a`; 5 `cancel_ack child/e2`; 6 deliver `child/e2`; 7 deliver `peer/e3`; 8 finish `child/e2`; 9 finish `peer/e3`; 10 seal | as S9, with `child` covered and `peer` not |

The supplement grows from 4 to 10 cases. All of them stay out of corpus coverage.

### 7.5 Tenant binding: security bounds (G1)

- **Trusted source.** The tenant comes only from the signed capability grant: a new grant version with a required `tenant_id`, covered by the issuer signature and by the capability fingerprint. It never comes from:
  - request metadata;
  - `agent_id`;
  - a session-id prefix;
  - adapter state.
- **Request and grant correspondence.**
  - The request's signed metadata may carry `tenant_id` (a reserved ACS field). If present, it must equal the grant's tenant. A mismatch is rejected before the guardian (`capability_rejected`, reason `tenant_mismatch`), and no execution starts. If absent, the grant's tenant applies.
  - The existing grant-to-request session match stays.
  - A pending approval keeps its grant snapshot, and re-verification fails when the re-resolved grant differs in any field, including the tenant.
- **Execution binding.** At start, the managed execution binds `tenant_id` together with `capability_id` and `session_id`. The commit, delivery and cancellation checks use this start-time binding, never a re-resolved grant.
- **Session namespace.**
  - A runtime `session_id` is unique within the runtime instance and bound to exactly one tenant at the first verified grant that names it. The binding is monotonic, like the capability binding.
  - A grant naming a session already bound to another tenant is rejected (`session_tenant_conflict`).
  - So a session revocation can never cross tenants, and a tenant revocation reaches a session through its binding, not through its name.
  - The early request check (before capability resolution) uses the binding for sessions already bound; the check after verification uses the grant's tenant.
  - The adapter keeps one distinct runtime session per contract `(tenant, session)` pair, as today, but the runtime's safety must not rely on naming.
- **Tenant revocation record.** A tenant revocation is monotonic and keyed by `tenant_id`. It is checked at use time. It covers every grant, session and execution bound to the tenant, including grants first seen after the revocation. Nothing is enumerated in advance.
- **Several records apply at once.** A use is denied if any applicable record matches: session, capability, tenant, or (with G2) an ancestor capability. A capability revocation by id stays in force whatever tenant a later grant claims.
- **Legacy tenantless grants.**
  - In a runtime instance with tenancy enabled, a grant without `tenant_id` (`CapabilityGrantV1`) is rejected (fail closed, `MISSING_TENANT`). There is no default tenant, and no "null tenant" namespace that tenant revocation does not reach.
  - If the runtime keeps a legacy mode, that mode offers no tenant revocation at all, is recorded in the lock, and its profile keeps tenant cases `OUT_OF_SCOPE`.
  - A mixed mode that accepts both versions at once is not acceptable.
- **Tenant switch under the same `capability_id`.**
  - The capability fingerprint covers `tenant_id`, so a second grant with the same `capability_id` and another tenant is rejected (`capability_id_conflict`), whichever is seen first.
  - Executions bound to the first grant keep their tenant binding.
  - So re-issuing an id under another tenant cannot escape either a tenant revocation of the original tenant or a capability revocation of the id.
- **Runtime-test mutants** (evidence: runtime-own tests):

  | Mutant | Removed or broken safeguard |
  |---|---|
  | M30 | tenant taken from request metadata instead of the signed grant |
  | M31 | tenantless grant accepted with tenancy enabled |
  | M32 | session not bound to one tenant (a second tenant can claim the same session) |
  | M33 | fingerprint excludes `tenant_id` (same id re-bound to another tenant) |
  | M33b | execution re-resolves its tenant at commit or delivery instead of using the start-time binding |

- **Adapter mutant.** AM12 "two contract tenants mapped onto one runtime session" must be detected by the adapter's identity-mapping check before the run.

### 7.6 Parent link: meaning and verification (G2)

- **Meaning.**
  - In package 1 the parent link is **issuer-attested derivation**. The trusted issuer signs a child grant that names its parent.
  - The runtime enforces both:
    - **revocation dependency**: the child can be used only while no capability in its chain is revoked;
    - **attenuation**: the child's `allowed_tools` are a subset of the parent's, its validity window lies within the parent's, and its tenant equals the parent's. Without attenuation, "descendant" would be a label rather than derived authority.
  - Holder-to-holder delegation, where a child is signed by the parent holder's key, is out of scope. It needs holder keys and a separate design and review.
- **Source of the verified chain.**
  - The child grant carries a signed reference `parent: { capability_id, fingerprint }`, where the fingerprint is that of the parent grant's body.
  - The capability provider returns the leaf grant together with its **complete ancestor chain** up to a root grant without a parent. Each grant in the chain is signed by the trusted issuer.
  - The runtime verifies every chain member: signature, structure, validity, fingerprint link to its child, attenuation and tenant. Only then does it accept the leaf.
  - The runtime never uses grants it has seen earlier as the source of a chain. It binds only grants seen in use, so the chain's availability cannot be assumed and must come with the request. Earlier bindings serve only as conflict checks.
- **Missing parent.** A grant that names a parent which the supplied chain does not contain, or a chain that does not end in a root, is rejected (`MALFORMED_CHAIN`, fail closed). It is never treated as a root.
- **Cycles.** A repeated `capability_id` anywhere in the chain is rejected. Fingerprint linkage makes a cycle infeasible as well, but the runtime does not rely on that.
- **Depth.** The chain is limited to a fixed maximum, provisionally 8 grants including the leaf. The constant is part of the runtime release and recorded in the lock. A longer chain is rejected, not truncated.
- **Tenant conflict.** Every chain member must have the leaf's `tenant_id`; otherwise the grant is rejected (`tenant_chain_mismatch`). Sessions may differ within the tenant. A session revocation covers only executions bound to that session; descendant coverage applies to capability-scope revocation.
- **Later link change.**
  - The fingerprint of every chain member covers its parent reference, and each member's `capability_id` is bound at first sight with the existing `bindCapability`. A chain that presents different content for an already bound id, including a different parent, is rejected (`capability_id_conflict`).
  - A running execution keeps the chain bound at its start (immutable). Its later fences check revocation of every id in that bound chain.
  - Revocation is by id, so it covers the id whatever content is presented later.
- **Ancestor never seen in use.** Revoking an ancestor id that the runtime has not seen yet still works, because the registry is keyed by id. The revocation covers any later chain that contains the id.
- **Cancellation fan-out.** `revoke()` requests cancellation for every running execution whose bound chain contains the revoked id. Today's direct match is extended; nothing else in the fan-out changes.
- **Adapter mapping.**
  - The harness acts as issuer, as it already does for grants. It signs child grants with parent references, and its capability provider returns the full chain.
  - Every contract `parent` link is mapped once the runtime supports chains. This replaces compatibility spec §3.4's rule that unrelated parent links are not modelled, so `sibling-isolation` becomes a real tree test.
  - Adapter mutant **AM13** "parent links dropped (independent grants)" is detected by S5 (start would be ALLOW) and by the identity-mapping check.
- **Runtime-test mutants** (evidence: runtime-own tests):

  | Mutant | Removed or broken safeguard |
  |---|---|
  | M38 | missing parent accepted as a root |
  | M39 | depth not limited |
  | M40 | repeated id accepted |
  | M41 | tenant mismatch in the chain accepted |
  | M42 | chain re-resolved at a later fence instead of using the start-time binding, or an already bound ancestor id re-bound to new content |
  | M43 | attenuation not enforced (child tool outside the parent's `allowed_tools`, or child validity beyond the parent's) |

### 7.7 Mutants by evidence type

| Evidence | Mutants | Gate |
|---|---|---|
| Corpus witness | M15, M16, M21, M22, M37 | The eval repo's mutation gate (typechecked patches, fixed witness, findings, exit) |
| Supplement witness | M20 (S5), M26 (S7), M34 (S8), M28 and M29 (S9), M35 and M36 (S10) | The same gate. The findings appear in the supplement section. |
| Runtime-own tests | M26a, M27a–d, M28a/b, M34a, M35a/b, M30–M33b, M38–M43 | A new gate step applies each patch to the pinned runtime and requires the runtime's own test suite to fail. It is reported separately from the contract mutants and never counted as corpus or supplement evidence. |
| Adapter | AM11 (tenant revoke expanded to session revokes), AM12, AM13 | The adapter-mutant checks, as for AM1–AM10 |

### 7.8 Acceptance criteria for package 1

- **Profile:** the classifier, from capability rules alone, yields 17 `IN_PROFILE` and 10 `OUT_OF_SCOPE` cases, golden-checked. `derived-authority` stays `OUT_OF_SCOPE` (needs G3).
- **Baseline run:**
  - 17/17 PASS, `corpus_coverage` 17/27;
  - supplement S1–S10 exactly as declared (S4 with its declared incompleteness only);
  - exit 3 and `contract_acceptance_passed: false`.
- **K count:** `not_assessed_requirements` rises from 34 to 43 (+4 `tenant-multi-session-in-flight`, +3 `tenant-isolation`, +2 `derived-in-flight-ancestor-revoked`).
- **Mutants:**
  - every corpus-witness and supplement-witness mutant in §7.7 is detected with its stated witness and findings;
  - every runtime-test mutant makes the pinned runtime's own suite fail;
  - AM11–AM13 are detected;
  - M1–M11 and AM1–AM10 are still detected with their current witnesses.
- **Fence matrix:** every cell of §7.3 has its stated evidence. No cell is claimed by a kind of evidence that cannot reach it; in particular, the start guard is claimed by runtime-own tests only.
- **No emulation:** no tenant or ancestor revoke is expressed by the adapter as several capability or session revokes. AM11 must be detected, for example by a probe-log check that the receipt target is the tenant. The adapter never infers coverage from the parent links it knows.
- **Determinism:** two runs are byte-identical and equal to the new fixture, and the recorded `evaluate` re-evaluation is identical.

### 7.9 Proposed sequence

Each step needs its own authorization.

1. **Runtime PR 1a, tenant scope** in `acs-guardrail-demo`: everything in §7.5, plus the runtime tests and runtime-test mutants for G1.
2. **Runtime PR 1b, descendant coverage:** everything in §7.6, plus the runtime tests and runtime-test mutants for G2.
3. **A runtime release** containing 1a and 1b.
4. **Eval PR:**
   - a new `sut.revocation.lock.json` pin (including the new SUT baseline counts and the chain-depth constant) and a new profile version;
   - classifier rules for tenant and descendant scope;
   - supplement S5–S10;
   - adapter mapping and the versioned runtime-observation schema revision (tenant target, identity tenants and parents);
   - the mutants of §7.7 and the runtime-test mutant gate step;
   - CI otherwise unchanged in shape.

### 7.10 Deferred after package 1

- **G3, then G4:** the largest remaining coverage gain (five cases, including `derived-authority`), but a lifecycle redesign that needs its own spec review.
- **G5 and G6:** both require a decision by the runtime owner on the addressable operation surface and the delivery model.
- **G7 and the K work (§5):** these follow G5(b) and G6.

## 8. Uncovered contract fences with no blocked corpus case

The profile also declares four unsupported classes that block no corpus case but limit what a PASS shows. They stay documented and are not part of package 1:

- `cancel_ack_after_runtime_terminal`: the runtime returns `false`, while the contract expects ALLOW for a bound execution whose finish was not requested. This is pinned by a conformance test.
- `cancel_ack_without_cancellation_request`: the runtime returns `false` without a prior revocation.
- `commit_once_only_sole_denial`: a second commit denied only because commit is once-only.
- `deliver_requires_commit_sole_denial`: a delivery denied only because no commit preceded it.

A later profile that adds corpus cases for them would need runtime support first, under the same rules (§1).

## 9. What this PR does not change

This PR adds this document only. No runtime, adapter, corpus, contract, profile, lock, schema, mutant or CI change is made.
