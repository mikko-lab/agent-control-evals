# Approval–permit lifecycle plan (G3/G4) — revocation track, `acs-guardrail-demo`

Status: **design proposal, not authorized for implementation.** This document changes no runtime, adapter, schema, corpus, supplement, profile or pin. It specifies the runtime approval–permit lifecycle that capability groups G3 (approval and permit lifecycle) and G4 (single-use permit) of the [coverage expansion plan](coverage-expansion-plan.md) need. With that lifecycle, pending approval, issued permit and single-use permit become separately assessable. Each work step of §10 needs its own authorization.

Starting point:
- `agent-control-evals` `main` @ `640bf281a7fd731f9cf670737b877a919ae669d9` (merge of mikko-lab/agent-control-evals#15).
- Contract `revocation-0.4.0` ([evaluation spec](evaluation-spec.md)).
- Pinned runtime `mikko-lab/acs-guardrail-demo` v0.5.0 @ `a9deab6709d6ca2ba8f3988693b50fa807eadc0c`, tenancy mode ([compatibility spec §13](runtime-adapter-compatibility.md#13-revision-for-the-v050-pin-coverage-expansion-package-1)).
- Declared profile `acs-guardrail-demo-a9deab6/revocation-0.4.0/3`: 17/27 `IN_PROFILE` (all PASS), 10 `OUT_OF_SCOPE`, 43 finish/seal decisions not assessed, supplement S1–S10 as declared, exit 3, `contract_acceptance_passed: false`.

The ground rules of the coverage plan (§1) apply unchanged:
- the capability belongs to the runtime;
- the adapter only maps;
- decision and effect stay separate;
- one pin, one profile;
- every fix has a proving mutant;
- nothing regresses;
- K stays K.

## 1. Three separate things

The contract treats each authority as **one approval/permit lineage** (evaluation spec §"Authority"): `approve` moves it from pending to approved, `issue` from approved to issued, and `start` consumes the single-use permit. The runtime must keep three things apart that this sentence touches:

| Concept | What it is | Who decides | Where it lives | What it can never do |
|---|---|---|---|---|
| **Authority validity** | The issuer-signed capability grant chain is verified, within its validity windows, bound (first-seen binding), and covered by no revocation (capability with descendants, session, tenant). | Capability verifier and revocation registry | `CapabilityGrantVerifier`, `AuthorityRevocationRegistry` | It is never granted by a human decision. A revocation is never undone. |
| **Human approval** | A human's signed decision on one concrete pending request: this tool, these arguments, under this authority snapshot. | The approver named in the Guardian's `ask_details` | Lineage record, approval part (§3.2) | Approval never makes revoked or invalid authority valid. It is a necessary, not a sufficient, condition for a permit. |
| **Permit use right** | The runtime's single-use right to start exactly one execution of the approved request. | The runtime, at `issue` and at the start effective point | Lineage record, permit part (§3.2) | A permit is no bearer credential and never substitutes for authority validity: every start re-checks authority. |

Each operation checks authority validity again at its own effective point (§5.4). Approval and permit state are **added** conditions on top of authority validity; neither can replace it.

## 2. The runtime today (v0.5.0 @ `a9deab6`)

Everything below refers to `src/guarded-executor.ts` and `src/execution-gate.ts` at the pin.

- **`process(request)`** (async). In order:
  1. schema validation, envelope signature, replay guard (timestamp and request id);
  2. a request-stage revocation check of the session and its bound tenant;
  3. capability resolution through the integrator's `CapabilityProvider` (a callback), followed by chain verification, binding and a second request-stage check;
  4. the `capability_verified` audit record (a callback);
  5. the Guardian decision (`read_record` ALLOW, `update_record` ASK with a human approver and `timeout_seconds: 300`, anything else DENY), followed by the `guardian_decision` audit record.
  - **ASK** stores a `PendingAction` with deep-cloned snapshots of the request, the response, the leaf grant and its ancestors, and returns `{ status: "pending" }`.
  - **ALLOW** starts the tool at once.
- **`resolveApproval(grant)`** (async). Verifies an `ApprovalGrantV2`:
  - the signature;
  - the human approver identity from the pending action;
  - binding to `session_id`, `request_id` and `tool`;
  - freshness and expiry.

  It then **deletes the pending action before** the approval fence (`#reverifyPendingAuthority`). That fence checks revocation, re-verifies the chain snapshot, re-resolves the provider, compares the snapshot and checks revocation again. If the fence passes, `resolveApproval` **starts the tool in the same call**. Approval and start are one operation, and a failed fence destroys the pending action.
- **Permits.** `ExecutionGate.mintPermit()` creates a per-request permit `{ sessionId, requestId, toolName }` inside the start path (a private `WeakSet`). `execute()` consumes it on entry, before the `tool_execution_started` audit callback and the start guard (`beforeInvoke`). A permit is neither invocable nor observable and is never shared between requests. A capability serves any number of requests (no single use per authority).
- **Revocation** covers pending actions and executions by the same predicate:
  - session equal;
  - capability equal, or contained in the bound ancestor chain;
  - tenant equal.

  The receipt lists covered `pending_approvals` and `in_flight_executions`. Stages: `request`, `approval`, `start`, `delivery`, plus the commit fence of the managed execution.

So the contract operations `approve` and `issue`, a pending authority before any request, and single use per authority have no runtime counterpart today: these are the unsupported classes `initial_pending_authority`, `approve`, `issue` and `single_use_permit`.

## 3. Proposed model and API

### 3.1 Permit mode

A new opt-in executor mode, **permit mode** (for example a constructor option `{ lifecycle: "permit" }`, independent of tenancy mode). Legacy mode stays the default and is unchanged, including `resolveApproval()` (§3.5). In permit mode **no operation starts a tool except `start()`, and `start()` requires an issued, unconsumed permit of the named lineage.**

### 3.2 The lineage record

One lineage record per approval/permit lineage (= one contract authority), keyed by a runtime-assigned `lineage_id`. It has two parts and a set of immutable bindings:

- **Bindings**, fixed at creation, frozen before the first callback:
  - `agent_id`, `session_id`, `tenant_id` (tenancy mode; from the verified grant only);
  - the leaf `capability_id` and its content fingerprint;
  - the ordered ancestor chain as `capability_id` and fingerprint pairs (parent first);
  - the tool name;
  - `arguments_digest`: the SHA-256 of the canonical JSON of the request arguments;
  - `request_digest`: the SHA-256 of the canonical `{ agent_id, session_id, tool, arguments }`;
  - the original `request_id`;
  - the approver identity from `ask_details`.
- **Approval part:** `approval_state` ∈ {`pending`, `approved`, `rejected`, `expired`}, `approval_expires_at`, `approved_seq`, `approver`.
- **Permit part:** `permit_state` ∈ {`none`, `issued`, `consumed`, `expired`}, `permit_id`, `permit_expires_at`, `issued_seq`, `consumed_seq`, `execution_id` (once consumed).

The **lifecycle state** used below is derived from the two parts:
- `pending`;
- `approved` (approved, permit `none`);
- `issued`;
- `consumed`;
- `rejected`;
- `approval_expired`;
- `permit_expired`.

The first four are exactly the contract's grant states (`state_at_cut`).

Revocation is **not** a lifecycle state. Whether a lineage is covered by a revocation is derived from the registry with the execution predicate (§2), and a read reports it as `covered_by: { revocation_id, reason } | null`. The registry changes only at a `revoke()` effective point, so this derived field is deterministic.

All `*_seq` values come from **one monotonic authority sequence** shared with `revoke()`'s `effective_sequence`. Approvals, issues, consumptions and revocations are thereby totally ordered by their effective points, and the order is observable.

### 3.3 Operations

| Operation | Signature (proposal) | Sync / async | Contract op |
|---|---|---|---|
| Create lineage | `process(signedRequest)` in permit mode → `{ status: "pending", lineage_id }` (Guardian ASK), `{ status: "approved", lineage_id }` (Guardian ALLOW, approver `policy`), or throws (Guardian DENY or any earlier check) | async (unchanged signature) | none; the contract's `initial` state is created at case setup (§7.2) |
| Approve | `approve(grant: ApprovalGrantV3)` → `ApprovalReceipt` | **sync** | `approve` |
| Reject | `reject(grant: ApprovalGrantV3 with decision "reject")` → `RejectionReceipt` | sync | none |
| Issue | `issuePermit({ lineage_id })` → `PermitReceipt { lineage_id, permit_id, issued_seq, expires_at }` | **sync** | `issue` |
| Start | `start({ lineage_id, request: signedRequest })` → `Promise<ProcessResult>` | async, but synchronous up to and including the tool call (§5.4) | `start` |
| Revoke | `revoke(target)`, unchanged; the receipt gains `pending_lineages`, `approved_lineages` and `unused_permits` (lineage ids covered at the effective point) | sync | `revoke` |
| Read | `getLineage(id)` and `lineages()` → frozen snapshot copies | sync | effect observation |

`approve` and `issuePermit` are synchronous by design: no Promise turn exists between their final fence and their transition (§5.9).

`ApprovalGrantV3` is `ApprovalGrantV2` plus `lineage_id`, `request_digest` and `authority_fingerprint`, all signed. `authority_fingerprint` is the SHA-256 over the leaf fingerprint and the ancestor fingerprints, in order. With these, a human approves exactly the request and authority snapshot they saw. A V3 grant names one lineage and cannot be replayed on another.

### 3.4 Reasons

Every denial is a typed error with a stage (`approval`, `issue`, `start`) and a reason. Revocation keeps `AuthorityRevokedError` with the new stage `issue`. The reasons map onto the contract's reason set:

| Runtime reason | Contract reason | Raised by |
|---|---|---|
| `capability_revoked`, `session_revoked`, `tenant_revoked`, `ancestor_revoked` | `revoked` | approve, issue, start |
| `not_pending` | `not_pending` | approve, reject |
| `not_approved` | `not_approved` | issue |
| `permit_not_issued` | `permit_not_issued` | start (lineage `pending`, `approved`, `rejected`, `approval_expired`) |
| `permit_consumed` | `permit_consumed` | start |
| `approval_expired`, `permit_expired` | none (runtime-specific) | approve, issue, start |
| `unknown_lineage` | none | approve, reject, issue, start |
| `approval_verification_failed` (with sub-reason) | none | approve, reject |
| `chain_snapshot_mismatch` | none | approve, issue, start |
| `lineage_binding_mismatch` (with the field) | none | start |

The evaluator compares decisions (ALLOW/DENY), not reasons. Reasons are runtime evidence for the runtime-own tests.

### 3.5 Relation to `process()` and `resolveApproval()`

| | Legacy mode (default, unchanged) | Permit mode (new) |
|---|---|---|
| `process()` Guardian ALLOW | starts the tool at once | creates a lineage `approved` by `policy`, starts nothing |
| `process()` Guardian ASK | `PendingAction`, `{ status: "pending" }` | lineage `pending`, `{ status: "pending", lineage_id }` |
| `process()` Guardian DENY | throws | throws, no lineage |
| `resolveApproval()` | approves **and** starts | rejected with a `LifecycleModeError` pointing to `approve()` / `reject()` |
| `approve()` / `reject()` / `issuePermit()` / `start()` / `getLineage()` | not available (throw `LifecycleModeError`) | the lifecycle of §4 |
| Per-request gate permit (`ExecutionGate`) | unchanged | unchanged and still required. The lineage permit is an **additional** condition, checked and consumed inside the start guard (§5.5). |

Keeping legacy mode unchanged means that existing integrators and the earlier eval pins are not affected (§12).

## 4. Lifecycle

### 4.1 Approval

```
            approve (all fences pass)
 pending ──────────────────────────────► approved ──issue──► (permit part, §4.2)
    │  reject                                 
    ├────────────────────────────────────► rejected      (final)
    │  approve/issue/start after approval_expires_at
    └────────────────────────────────────► approval_expired  (final)
```

A revocation leaves the approval state unchanged. A covered lineage can never again pass an approval, issue or start fence. Revocation is monotonic, so it is final in effect.

### 4.2 Permit

```
 none ──issue──► issued ──start (final guard passes)──► consumed   (final)
                   │ start after permit_expires_at
                   └──────────────────────────────────► expired    (final)
```

An issued permit whose lineage is then revoked stays `issued`, because it was never used. It is reported as unused in the revocation receipt, and every start is denied (`revoked`). It never becomes usable again.

### 4.3 Transition table

`fences(stage)` means: every revocation check of the stage for the lineage's bound authority (session, capability, tenant, ancestors), the authority re-verification (§5.2), and the binding comparison. Expiry is evaluated with the executor's clock at the operation and recorded by that operation (§11 D8).

| # | From | Operation | Conditions | Decision | New state | Observable effect (runtime state) |
|---|---|---|---|---|---|---|
| T1 | — | `process(r)` ASK | schema, signature, replay, request-stage revocation, chain verified and bound, Guardian ASK (human) | ALLOW (pending) | `pending` | new lineage with bindings; `approval_requested` audit (diagnostic only) |
| T2 | — | `process(r)` ALLOW | as T1, Guardian ALLOW | ALLOW (approved) | `approved` (approver `policy`) | new lineage, `approved_seq` |
| T3 | — | `process(r)` DENY or any check fails | — | DENY | none | none |
| T4 | `pending` | `approve(g)` | not expired; grant valid (signature, approver, `lineage_id`, `request_digest`, `authority_fingerprint`); `fences(approval)` | ALLOW | `approved` | `approval_state = approved`, `approved_seq` → **`approval_granted`** |
| T5 | `pending` | `approve(g)` | expired | DENY `approval_expired` | `approval_expired` | state recorded |
| T6 | `pending` | `approve(g)` | revoked (any covering scope) | DENY `revoked` | unchanged | none |
| T7 | `pending` | `approve(g)` | grant invalid, chain changed, provider error | DENY (`approval_verification_failed`, `chain_snapshot_mismatch`, `capability_*`) | unchanged | none |
| T8 | `pending` | `reject(g)` | grant valid | ALLOW | `rejected` | `approval_state = rejected` |
| T9 | not `pending` | `approve` / `reject` | — | DENY `not_pending` | unchanged | none |
| T10 | `approved` | `issuePermit` | approval not expired; `fences(issue)` | ALLOW | `issued` | `permit_state = issued`, `permit_id`, `issued_seq` → **`permit_issued`** |
| T11 | `approved` | `issuePermit` | revoked | DENY `revoked` | unchanged | none |
| T12 | `approved` | `issuePermit` | chain changed, provider error, approval expired | DENY | unchanged (`approval_expired` recorded when expired) | none |
| T13 | not `approved` | `issuePermit` | — | DENY `not_approved` | unchanged | none |
| T14 | `issued` | `start(l, r)` | `r` valid (schema, signature, replay); bindings equal; not expired; `fences(start)` at the early check **and** at the final guard; gate permit valid | ALLOW | `consumed` | `permit_state = consumed`, `consumed_seq`, `execution_id`; tool invoked → **`execution_started`** |
| T15 | `issued` | `start` | revoked at the early check or at the final guard | DENY `revoked` | unchanged (`issued`) | none; tool not invoked |
| T16 | `issued` | `start` | binding mismatch, chain changed, `r` invalid or replayed | DENY | unchanged | none |
| T17 | `issued` | `start` | permit expired | DENY `permit_expired` | `permit_expired` | state recorded |
| T18 | `consumed` | `start` | — | DENY `permit_consumed` | unchanged | none |
| T19 | `pending`, `approved`, `rejected`, `approval_expired` | `start` | — | DENY `permit_not_issued` | unchanged | none |
| T20 | any | `revoke(target)` covering the lineage | — | ALLOW (receipt) | unchanged | revocation record; the lineage appears in `pending_lineages`, `approved_lineages` or `unused_permits` |
| T21 | `consumed` | tool throws, start fence of the managed execution, delivery withheld | — | (the start was ALLOW) | `consumed` | execution terminal as today |
| T22 | any | unknown `lineage_id` | — | DENY `unknown_lineage` | — | none |

### 4.4 Repeated calls and errors

- **No operation is idempotent except `revoke()`.** Each call is a new decision:
  - a second `approve` is DENY `not_pending`;
  - a second `issuePermit` is DENY `not_approved`;
  - a second `start` is DENY `permit_consumed`.

  These match the contract (`not_pending`, `not_approved`, `permit_consumed`). `revoke()` stays idempotent with the original effective point (`already_revoked`).
- **A denied operation never changes lifecycle state.** The only exception is an expiry that the operation observes (T5, T12, T17). This also holds for denials at the approval fence. Today's `resolveApproval()` deletes the pending action before the fence; permit mode deliberately differs (§11 D7).
- **Errors after the effective point never undo it.** An audit sink that throws after a transition leaves the transition in place and is reported as missing evidence, as `revoke()` does today with `audit_recorded`. The adapter therefore takes effects from lineage state, never from the return value or the audit.
- **Errors before the effective point are denials** without a state change, including a throwing provider, a throwing audit sink on the path, or a schema or signature failure.
- **Malformed calls** (missing or unknown `lineage_id`, wrong mode) are typed errors. They are DENY for the contract decision and change nothing.

## 5. Security semantics

### 5.1 Immutable permit bindings

The permit inherits the lineage bindings of §3.2. A start compares the fresh, signed start request and the authority resolved for it against **every** binding before any state changes. The comparison is on clones taken at entry, so getters, proxies or later caller mutations cannot change what is compared.

| Binding | Start-side value | Why it is bound |
|---|---|---|
| authority: leaf `capability_id` and fingerprint | provider re-resolution for the start request, verified | a permit of authority A must never start under authority B, not even inside the same session |
| ancestor chain: ordered ids and fingerprints | the provider's chain for the start request, compared member by member before verification (as `#matchesChainSnapshot`) | a re-issued parent or a dropped ancestor changes which revocations cover the execution |
| tenant | the tenant of the verified leaf | tenants are revocation scopes; the request's own `tenant_id` claim must also match (as today) |
| session, agent | the request metadata, and the grant binding | session is a revocation scope; the replay guard is per session |
| tool | the request's tool name | the approval was for this tool |
| arguments | `arguments_digest` of the start request | the human approved these arguments; the same tool with other arguments is another action |

A mismatch is DENY `lineage_binding_mismatch` (with the field). It changes no state (§11 D7). The legitimate start can follow; a mismatching attempt cannot burn the permit.

### 5.2 Approval binding

- The approval is bound to the original request through `request_digest` and to the verified grant chain through `authority_fingerprint`. Both are signed in `ApprovalGrantV3` and compared with the lineage bindings.
- The approval fence (T4) then re-verifies authority, in the same three steps as today's `#reverifyPendingAuthority`:
  1. revocation of every bound scope;
  2. current validity of the snapshot chain;
  3. the provider still resolves the identical chain for the original context, followed by verification, binding and a second revocation check.
- A provider answer is evidence only that the context is still authorized. It never replaces the bound authority.

The same re-verification runs at `issuePermit` (T10) and at the start early check (T14). Every one of approve, issue and start therefore stands on authority that is valid at its own effective point.

### 5.3 Revocation of pending approvals and unused permits

Coverage uses the execution predicate on the lineage bindings, for every current scope:

| Lineage state at the revocation | capability scope (target or an ancestor in the bound chain) | session scope | tenant scope |
|---|---|---|---|
| `pending` | approve DENY, issue DENY, start DENY; listed in `pending_lineages` | same | same |
| `approved` | issue DENY, start DENY; listed in `approved_lineages` | same | same |
| `issued` (unused) | start DENY; permit stays `issued`; listed in `unused_permits` | same | same |
| `consumed` (running execution) | existing containment: commit and delivery fences, cancellation request | same | same |
| `consumed` (terminal) | historical effects stay | same | same |

**No lifecycle step revives a revoked lineage:**
- a later approval, issue or fresh-ID start is denied;
- a new lineage for the same revoked authority is denied at `process()` (request stage);
- a permit issued before the cut is never usable after it.

This is the contract's "no late approval, late issue or permit replay can revive a revoked lineage".

### 5.4 Effective points

Every operation has one **binding effective point**. It is the synchronous check-and-set at which the decision becomes final. It runs **after the operation's last integrator callback**, with no callback and no Promise turn between the final fence and the state transition.

| Operation | Last callback before the effective point | Effective point (one synchronous segment) | Callbacks after it |
|---|---|---|---|
| `revoke` | none | registry record and sequence (unchanged) | `authority_revoked` audit, cancellation listeners |
| `process` → lineage | `guardian_decision` audit | lineage record created and frozen | `approval_requested` audit |
| `approve` | provider re-resolution and the audit of the verification | final revocation check → state still `pending` and not expired → `approved`, `approved_seq` | `approval_granted` audit |
| `reject` | none after grant verification | state still `pending` → `rejected` | `human_rejection` audit |
| `issuePermit` | provider re-resolution | final revocation check → state still `approved` and approval not expired → `issued`, `permit_id`, `issued_seq` | `permit_issued` audit |
| `start` | `tool_execution_started` audit (as today) | inside `beforeInvoke`: final revocation check → lineage still `issued`, not expired, bindings unchanged → `consumed`, `consumed_seq` → managed execution created → **tool function called** | tool body, then the result path and delivery fences (unchanged) |

"Still `pending`", "still `approved`" and "still `issued`" are re-read at the effective point. This is a **check-and-set on the current state**, never on a state seen at an earlier check (§5.9).

### 5.5 Atomic single use

- **Where consumption happens.** The lineage permit is consumed **at the start effective point and nowhere else**: in the same synchronous segment as the final start guard, immediately before the tool function call. This is the same segment that today holds the start guard and creates the managed execution.
- **Why there is no consumption at an early check.** An early check of the permit state is a fail-fast denial only and changes nothing. A reservation at an early check would leave a permit consumed by an attempt that a later fence denies. Releasing that reservation again would reopen the race (§11 D6).
- **Concurrent attempts.** JavaScript runs one segment at a time, so the check-and-set at the effective point is atomic. Of any number of concurrent or re-entrant starts on one lineage, exactly one passes. The others are DENY `permit_consumed` at their own final guard, whatever their early checks saw. This covers:
  - two `start()` calls under `Promise.all`;
  - a start re-entered from an audit sink;
  - a start re-entered from the provider;
  - a start re-entered from the running tool itself.
- **The gate permit.** `ExecutionGate`'s per-request permit stays as it is, consumed on gate entry. It binds the execution to one request. The lineage permit binds it to one approval.

### 5.6 A failed start

| Where the start fails | Lineage permit afterwards | Why |
|---|---|---|
| Before the effective point: invalid request, replay, binding mismatch, revocation, expiry, provider or audit callback throws, gate permit invalid | unchanged (`issued`, or `permit_expired`) | No execution exists. Burning the permit would let a mismatching or failing attempt destroy a legitimate right. |
| At or after the effective point: the tool throws or returns an error, its commit or delivery is fenced, the result is withheld | `consumed` | The execution started. The contract's `start` consumed the permit, and a retry needs a new lineage. |

### 5.7 Ordering of concurrent revoke, approve, issue and start

All effective points are totally ordered by the shared authority sequence (§3.2). The rule is the contract's step rule, applied to effective points:

- **The operation came first.** If an operation's effective point precedes a covering revocation's effective point, it stands as a historical fact:
  - an approval granted before the cut stays `approved`;
  - a permit issued before the cut stays `issued` but unusable;
  - a start before the cut is an execution under the existing containment.
- **The revocation came first.** If the revocation's effective point precedes the operation's final fence, the operation is DENY `revoked`.
- **Interleaving inside an operation.** A revocation that happens inside an operation, in one of its callbacks before the effective point, is seen by the final fence. That operation is denied.
- **Approve against approve, and issue against issue.** The check-and-set (§5.4) lets exactly one of two racing operations on one lineage succeed. The other gets `not_pending` or `not_approved`.

### 5.8 Fail-closed binding handling

- Any binding that cannot be read, compared or verified is a denial:
  - a provider error;
  - a thenable or Proxy answer;
  - a chain envelope with a different length;
  - a grant whose fingerprint cannot be computed;
  - a missing `request_digest` in a V3 grant.

  The runtime never falls back to a weaker comparison.
- `capability_id` and session-tenant first-seen bindings stay as they are. A lineage binding never overrides them, and they never override a lineage binding.
- A lineage snapshot that differs from the registry's binding for the same `capability_id` is `chain_snapshot_mismatch`, never a re-binding.

### 5.9 Bypass analysis: callbacks and Promise turns

Integrator callbacks on these paths:
- every `audit.record` (audit sinks);
- `CapabilityProvider.resolve`;
- `Guardian.evaluate`;
- cancellation listeners;
- the tool function.

A callback may call any public operation re-entrantly, including `revoke`, `approve`, `issuePermit` and `start`.

| # | Scenario | Rule that closes it | Outcome required |
|---|---|---|---|
| B1 | Revoke from the provider callback during `approve` or `issuePermit` | final revocation check after the last callback (§5.4) | DENY `revoked`, no transition |
| B2 | Revoke from the `approval_granted` or `permit_issued` audit sink, after the transition | transition before the audit | the approval or permit stands as historical; the next issue or start is DENY |
| B3 | Re-entrant `approve` on the same lineage from the provider callback of an outer `approve` | check-and-set on the current state | the inner one approves; the outer one is DENY `not_pending`; one `approved_seq` |
| B4 | Re-entrant `start` from the first start's `tool_execution_started` audit sink | permit consumed only at the final guard, which re-reads the state | exactly one tool call; the other start is DENY `permit_consumed` |
| B5 | Two `start()` calls interleaved by Promise turns (`Promise.all`, an async provider) | no `await` between the final guard and the tool call; check-and-set | exactly one tool call |
| B6 | The tool function calls `start` on its own lineage | the permit is already `consumed` | DENY `permit_consumed` |
| B7 | Revoke from the `tool_execution_started` audit (the last callback before the tool call) | the final guard re-checks revocation (today's start guard, extended) | DENY `revoked`; the permit stays `issued`; no tool call |
| B8 | Caller mutates the request or grant object while the call is awaited; getters or Proxies in the input | clone and canonicalize at entry; digests computed once; the tool receives the clone | comparisons and the tool see the entry values |
| B9 | The audit sink receives a live lineage or binding object and mutates it (the aliasing class of the v0.5.0 fix C6) | bindings frozen before the first callback; callbacks receive copies | no callback can change a binding or state |
| B10 | An audit sink throws on the start path before the effective point | today `execute()` aborts before `beforeInvoke` | DENY; permit unchanged; no tool call |
| B11 | An audit sink throws after an effective point | an error after the effective point never undoes it (§4.4) | the transition stands; evidence reported missing |
| B12 | An audit event, a receipt or a return value claims a permit or a start that runtime state does not show | effects come only from lineage snapshots and tool-double invocation | no effect; the adapter must report none |

**An audit decision event is never evidence by itself.** `approval_granted`, `permit_issued` and `tool_execution_started` audit records show that a code path ran, not that a transition happened or that the tool was called. The evidence is the lineage snapshot (approval state, permit state, `*_seq`) and the tool double's own entry probe (§7.1).

## 6. Corpus impact

The classifier marks a case `OUT_OF_SCOPE` by capability class (`src/profile/revocation/classifier.ts`). With the profile capability rules extended by the four G3/G4 classes and nothing else, it gives the following for all 27 cases. The computation uses the current classifier with the a9deab6 profile's revoke-scope rules, ignoring exactly the classes `initial_pending_authority`, `approve`, `issue` and `single_use_permit`.

| Case | Today | With G3/G4 | K (finish/seal) | Pending authorities | approve / issue steps | Blocking classes today |
|---|---|---|---|---|---|---|
| `pending-approval` | OUT | **IN** | 2 | a | approve, issue | initial_pending_authority, approve, issue |
| `issue-after-cut` | OUT | **IN** | 2 | a | approve, issue | initial_pending_authority, approve, issue |
| `issued-permit` | IN | IN | 3 | — | — | — |
| `fresh-id-retry-unused-permit` | OUT | **IN** | 3 | a | approve, issue | initial_pending_authority, issue, approve |
| `cut-before-start` | IN | IN | 2 | — | — | — |
| `duplicate-revocation` | IN | IN | 2 | — | — | — |
| `active-session` | IN | IN | 3 | — | — | — |
| `session-in-flight-commit-fence` | IN | IN | 3 | — | — | — |
| `session-delivery-fence-after-commit` | IN | IN | 2 | — | — | — |
| `tenant-multi-session-in-flight` | IN | IN | 4 | — | — | — |
| `start-before-cut` | IN | IN | 2 | — | — | — |
| `in-flight-before-commit` | IN | IN | 2 | — | — | — |
| `late-commit-after-terminal` | OUT | OUT | 2 | — | — | deliver_after_finish (G6) |
| `retry-after-revocation` | OUT | OUT | 3 | — | — | operation_on_execution_unknown_to_runtime (G5b) |
| `in-flight-after-commit` | IN | IN | 2 | — | — | — |
| `commit-before-cut` | IN | IN | 2 | — | — | — |
| `commit-shift-across-cut` | IN | IN | 2 | — | — | — |
| `cancel-is-not-rollback` | OUT | OUT | 2 | — | — | deliver_after_finish (G6) |
| `derived-authority` | OUT | **IN** | 2 | pending-child | approve, issue | initial_pending_authority, approve, issue |
| `derived-in-flight-ancestor-revoked` | IN | IN | 2 | — | — | — |
| `sibling-isolation` | IN | IN | 4 | — | — | — |
| `session-isolation` | IN | IN | 3 | — | — | — |
| `tenant-isolation` | IN | IN | 3 | — | — | — |
| `execution-id-reuse` | OUT | OUT | 3 | — | — | client_chosen_execution_id, operation_on_execution_unknown_to_runtime (G5a, G5b) |
| `permit-single-use` | OUT | **IN** | 3 | — | — | single_use_permit |
| `approval-before-cut` | OUT | **IN** | 2 | a | approve, issue | initial_pending_authority, approve, issue |
| `deferred-terminal-before-seal` | IN | IN | 2 | — | — | — |

**Coverage.**
- **Moved cases.** Six move into the profile: `pending-approval`, `issue-after-cut`, `fresh-id-retry-unused-permit`, `derived-authority` (it needs G2 too, which v0.5.0 has), `permit-single-use` and `approval-before-cut`. Corpus coverage becomes **23/27**, from 17/27.
- **Remaining `OUT_OF_SCOPE`.** Four cases stay out, and this plan does not promise them: `late-commit-after-terminal` and `cancel-is-not-rollback` need G6, `retry-after-revocation` needs G5(b), and `execution-id-reuse` needs G5(a) and G5(b).
- **Unassessed finish/seal decisions (K).** K rises from **43 to 57**: +2, +2, +3, +2, +3 and +2 for the six moved cases. The four remaining cases hold 10 more, so 67 in all 27 cases.
- **Newly assessed decisions.** 28 non-K decisions of the six moved cases become assessed: steps 0–3, 0–3, 0–4, 0–3, 0–3 and 0–6.
- **Acceptance.** `contract_acceptance_passed` stays false and the declared-profile exit stays 3. G3/G4 do not touch K (G5–G7 and coverage plan §5).

**Changes to the cases already in the profile.**
- **Family caveats.** The caveats of `issued-permit`, `cut-before-start` and `duplicate-revocation` ("the runtime has no permit object…") become obsolete. Their authorities start `issued` with a real, unused permit, so the fresh-ID retry in `issued-permit` (step 2) meets an unused permit. The new profile drops those caveats.
- **Design fences.** The uncovered design fences "approve (authority, descendant)", "issue (authority)" and "single use" become corpus-covered:
  - approve authority by `pending-approval` and descendant by `derived-authority`;
  - issue authority by `issue-after-cut`;
  - single use by `permit-single-use`.

  The "execution identity" fence stays uncovered (G5).
- **No double starts.** No current `IN_PROFILE` case starts one authority twice with ALLOW. `issued-permit` denies both starts by revocation. Single use therefore masks no existing witness by itself. Every existing witness is still re-verified under permit mode (§10 step 4).

## 7. Evidence and tests

### 7.1 Kinds of evidence

| Layer | Where | What it shows | Counts toward |
|---|---|---|---|
| **Corpus** | the 23 `IN_PROFILE` cases, evaluated against the oracle through the runtime's public API and state | decisions of approve, issue and start; `approval_granted`, `permit_issued` and `execution_started` effects at their steps | corpus coverage, `profile_acceptance_passed` |
| **Supplement** | new cases S11–S14 (§7.3), golden-hashed, contract vocabulary | the approval, issue and start fences under session, tenant and ancestor scope that the corpus does not reach | `supplement_acceptance_passed` only |
| **Runtime-own tests** | `acs-guardrail-demo` test suite and its mutant gate (§8.2) | what the contract cannot express: expiry, reject, binding mismatches, chain changes, concurrent and re-entrant starts, callback ordering, failed starts | the lock's baseline and runtime gate evidence, never profile or supplement |
| **Component tests** | runtime unit tests of single comparators (binding comparison, digest) | check points masked on every production path (§8.2 M55, M56) | `component_check_point` only, never production-path evidence |

**Effect sources:**
- `approval_granted`: the first probe in which the lineage snapshot shows `approval_state = approved`;
- `permit_issued`: the first probe in which it shows `permit_state` ∈ {`issued`, `consumed`};
- `execution_started`: the tool double's entry probe, attributed from the runtime binding, as today;
- permit consumption: `permit_state = consumed` with `execution_id`. This is a runtime-own and supplement observation; the contract has no `permit_consumed` effect.

**Decision source.** Decisions come from the call answer of the step's own runtime call: a receipt is ALLOW, a typed error is DENY. Audit records stay diagnostics.

### 7.2 Corpus mapping

- **Setup** (before step 0, never assessed, the same kind of setup S1 uses today). For each authority, the adapter creates its lineage through runtime calls:
  - `initial: pending`: `process(r)` with an ASK tool;
  - `initial: issued`: `process(r)` with an ASK tool, then `approve(g)` with a signed human `ApprovalGrantV3`, then `issuePermit`.

  The request `r` uses the authority's fixed tool and arguments under its grant chain. Any setup denial is a harness error (`setup_failed`), never a decision. The identity mapping gains `lineages: { lineage_id → authority }`. The evaluator checks it as it checks capabilities. The first probe must show each lineage in exactly its authority's `initial` state (pending, or issued and unconsumed).
- **Steps:**
  - `approve(a)` → `approve(gV3)` on a's lineage;
  - `issue(a)` → `issuePermit({ lineage_id })`;
  - `start(a, e)` → `start({ lineage_id, request })` with a fresh signed request carrying a's tool and arguments;
  - `revoke` → unchanged.
- **Observation.** Probe state gains the lineage snapshots: states, `*_seq`, `permit_id`, `execution_id` and the bindings digest. This is a versioned runtime-observation format 3; formats 1 and 2 are still evaluated unchanged.

### 7.3 Supplement (proposed S11–S14)

Each case has fresh state, contract-vocabulary expectations from the oracle, a finish for every start and a seal. Its finish/seal decisions are K, as for S1–S10.

| Case | Authorities | Steps | Expected |
|---|---|---|---|
| S11 `sup-session-revoke-pending-approval` | `a` pending (t1,s1); `b` pending (t1,s2) | 0 revoke session (t1,s1); 1 approve a; 2 issue a; 3 start a/e1; 4 approve b; 5 issue b; 6 start b/e2; 7 finish a/e1; 8 finish b/e2; 9 seal | approve, issue and start of `a` DENY; `b` approve, issue and start ALLOW (non-coverage) |
| S12 `sup-tenant-revoke-unused-permit` | `a` pending (t1,s1); `b` pending (t2,s1) | 0 approve a; 1 issue a; 2 approve b; 3 issue b; 4 revoke tenant t1; 5 start a/e1; 6 start b/e2; 7 finish a/e1; 8 finish b/e2; 9 seal | `permit_issued` for both before the cut; start of `a` DENY; start of `b` ALLOW |
| S13 `sup-ancestor-revoke-unused-permit` | `p` issued; `c` pending, parent `p`; `q` pending, no parent | 0 approve c; 1 issue c; 2 approve q; 3 issue q; 4 revoke p; 5 start c/e1; 6 start q/e2; 7 finish c/e1; 8 finish q/e2; 9 seal | start of `c` DENY; start of `q` ALLOW |
| S14 `sup-ancestor-revoke-approved-before-issue` | `p` issued; `c` pending, parent `p` | 0 approve c; 1 revoke p; 2 issue c; 3 start c/e1; 4 finish c/e1; 5 seal | `approval_granted@0` stays; issue and start DENY |

### 7.4 Runtime-own deterministic tests

These run on the injected clock and the deterministic test doubles of the runtime suite. Each names its control and the exact assertion. In each, "no tool call" is asserted through the tool's own invocation counter, not through the audit.

| Test | Scenario | Assertions (control) |
|---|---|---|
| L1 | Revoke while pending, once for each scope: capability, ancestor, session, tenant | `approve` DENY `revoked` (stage `approval`); the lineage stays `pending`; `issuePermit` and `start` DENY; tool calls 0; the receipt lists the lineage in `pending_lineages` |
| L2 | Revoke after issue, before start, each scope | `start` DENY `revoked` (stage `start`); permit `issued`, `consumed_seq` absent; tool calls 0; receipt `unused_permits` |
| L3 | Valid lifecycle: approve, issue, start | each receipt in order with increasing `*_seq`; tool calls 1; permit `consumed` with the started `execution_id` |
| L4a | Sequential reuse: a second start on a consumed lineage | DENY `permit_consumed`; tool calls stay 1 |
| L4b | Concurrent: two `start()` under `Promise.all` | exactly one ALLOW and one DENY `permit_consumed`; tool calls 1 |
| L4c | Re-entrant start from the first start's `tool_execution_started` audit sink | the inner one ALLOW, the outer one DENY `permit_consumed`; tool calls 1 |
| L4d | Re-entrant start from the provider callback, and from the tool body | tool calls 1; the loser DENY |
| L5 | Wrong tenant, session, authority, tool or arguments, one field per test. The start request comes with a grant that is valid for its own context, so only the lineage binding can reject (§8.2 masking). | DENY `lineage_binding_mismatch` naming that field; the lineage stays `issued`; a following correct start ALLOW with tool calls 1 |
| L6 | The grant chain changes at approve, at issue and at start: a re-issued parent with a new fingerprint, a dropped ancestor, a different leaf | DENY `chain_snapshot_mismatch` at that stage; state unchanged; tool calls 0 |
| L7a | Revoke inside the last callback before issuance (provider re-resolution in `issuePermit`) | DENY `revoked`; permit `none` |
| L7b | Revoke inside the last callback before the tool call (`tool_execution_started` audit sink) | DENY `revoked`; permit `issued`; tool calls 0 |
| L7c | Revoke inside the `permit_issued` audit sink (after the transition) | the permit stays `issued`; the next start DENY |
| L8 | Approval never restores authority: revoke, then a valid V3 approval | DENY; a new `process()` for the same authority is DENY at request |
| L9 | Expiry: approval past `approval_expires_at`; permit past `permit_expires_at` | DENY `approval_expired` / `permit_expired`; state recorded; tool calls 0 |
| L10 | Reject, then approve, issue, start | DENY `not_pending`, `not_approved`, `permit_not_issued` |
| L11 | The tool throws after the start effective point | permit `consumed`; execution terminal `failed`; a second start DENY `permit_consumed` |
| L12 | Permit-mode `resolveApproval` and legacy-mode lifecycle methods | `LifecycleModeError`; the legacy suite is unchanged |
| L13 | An audit sink that throws, and one that emits fake `permit_issued` / `tool_execution_started` events | lineage state and tool calls unaffected |
| L14 | Aliasing and input mutation (B8, B9) | bindings and digests unchanged; the tool receives the entry arguments |

### 7.5 Component tests

- Binding comparator: one assertion per field.
- Digest canonicalization: key order, Unicode, numbers.
- Authority-fingerprint computation.

These back only the check points no production path separates (§8.2).

## 8. Mutants

Rules as for package 1 (coverage plan §7.8 and the eval gate, compatibility spec §13.6):
- every mutant is named before any run, with its patch hash, control, witness, exact assertion and evidence kind;
- a patch that does not apply or typecheck, a changed test inventory, a process error, a timeout, a harness error or any technical error that is not predeclared is a technical failure, never a kill;
- the control must pass first;
- a mutant that changes only a rejection code is `check_point` at most;
- no kept safeguard is removed or weakened to give another check a witness.

Lifecycle state is runtime state. Its change is reported under a separate label, **`lifecycle_effect`**, so it is never counted as containment (§11 D12). The kinds are:
- `check_point`;
- `lifecycle_effect`, alone or with a check point (`check_and_lifecycle`);
- `containment_effect` or `both`, where the tool is called or managed state changes;
- `component_check_point`.

### 8.1 Corpus and supplement witnesses (eval mutant gate)

Numbers M12–M14, M24 and M25 are those of the coverage plan. M49 and later are new; M15–M48 are taken by package 1. The findings listed are the minimum. The complete values, run exits and run exceptions are pinned in the eval manifest before the gate run, as for package 1.

| Mutant | Removes | Witness | Minimum findings | Kind | Masking analysis |
|---|---|---|---|---|---|
| M12 | revocation check at the approval fence | `pending-approval` | `false_allow@1`, `unexpected_approval_granted@1` | check and lifecycle | The issue and start fences still deny steps 2–3, so containment is unaffected. The witness asserts the approval itself, which nothing else masks. |
| M13 | revocation check at the issue fence | `issue-after-cut` | `false_allow@2`, `unexpected_permit_issued@2` | check and lifecycle | The start fence masks step 3. The permit record at step 2 is unmasked. |
| M14 | the start's lineage-state requirement (a start without an issued permit) | `fresh-id-retry-unused-permit` | `false_allow@0`, `unexpected_execution_started@0` | both | Nothing else denies step 0: no revocation, valid authority. |
| M24 | consumption not recorded at the final guard | `permit-single-use` | `false_allow@1`, `unexpected_execution_started@1` | both | The gate permit is per request and the fresh retry has its own request, so it does not mask. |
| M25 | over-fencing control: the issue step checks the wrong state (requires `pending` instead of `approved`) | `approval-before-cut` | `false_deny@1`, `missing_permit_issued@1` | check and lifecycle | A valid lifecycle with no revocation before step 6, so only the wrong state check denies. It catches an over-blocking fix of M12–M14. |
| M49 | all revocation checks on the start-with-permit path (early and final) | `fresh-id-retry-unused-permit` | `false_allow@4`, `unexpected_execution_started@4` | both | The permit is issued and unused, so only revocation denies. Removing one start check alone is masked by the other (runtime-own M54, M57). |
| M50 | session and tenant coverage of lineages at the approval fence | S11 | `false_allow@1`, `unexpected_approval_granted@1` | check and lifecycle | The issue fence still checks the scope, so the witness is the approval step. |
| M51 | tenant coverage at start for permits issued before the cut | S12 | `false_allow@5`, `unexpected_execution_started@5` | both | — |
| M52 | ancestor coverage at the issue fence | S14 | `false_allow@2`, `unexpected_permit_issued@2` | check and lifecycle | The start fence masks step 3. |

### 8.2 Runtime-own mutants (runtime mutant gate, new manifest `mutants/lifecycle/manifest.json`)

| Mutant | Removes | Control → mutant (exact assertion) | Witness | Kind | Masking analysis |
|---|---|---|---|---|---|
| M53 | check-and-set: consumption checks a state read at an early check | L4c: tool calls `1 → 2`; outer start `permit_consumed → ok` | L4c, L4b | both | Only the final-guard re-read prevents the second call. The gate permit is per request and does not mask. |
| M54 | final revocation check of the start guard on the permit path | L7b: tool calls `0 → 1`; stage `start → none` | L7b | both | The early start check passed before the revocation, so nothing else denies. |
| M55 | session comparison of the lineage binding | component: comparator result `session → null` | component test | component_check_point | **Masked on every production path:** a request in another session needs a grant bound to that session, whose `capability_id` differs. The authority comparison (M58) rejects it first. Gap recorded, like M33. |
| M56 | tenant comparison of the lineage binding | component: comparator result `tenant → null` | component test | component_check_point | Masked by the authority comparison, because the tenant comes from the grant. Gap recorded. |
| M57 | early start check on the permit path | stage `start (early) → start (final)` | L2 | check_point | The final guard still denies. Containment is unchanged. |
| M58 | authority (leaf and chain fingerprint) comparison at start | L5 (authority): tool calls `0 → 1`; reason `lineage_binding_mismatch:authority → ok` | L5-authority | both | The witness grant for B is valid for the same session, tenant and tool, so only the binding rejects. |
| M59 | tool comparison | L5 (tool): tool calls `0 → 1` | L5-tool | both | The witness grant allows both tools, so the capability scope does not mask. |
| M60 | arguments-digest comparison | L5 (arguments): tool calls `0 → 1` | L5-arguments | both | Same tool, other arguments, within the grant: no other check separates. |
| M61 | chain snapshot comparison at approval | L6 (approve): approval state `pending → approved` | L6-approve | check and lifecycle | The issue and start comparisons still deny later. The witness asserts the approval. |
| M62 | chain snapshot comparison at start | L6 (start): tool calls `0 → 1` | L6-start | both | — |
| M63 | issue fence evaluated before the provider callback | L7a: permit `none → issued` | L7a | check and lifecycle | The start fence still denies, so containment is unaffected. |
| M64 | a failed start releases the permit | L11: second start `permit_consumed → ok`; tool calls `1 → 2` | L11 | both | — |
| M65 | a denied start burns the permit (over-fencing control) | L5 follow-up: the correct start `ok → permit_consumed`; tool calls `1 → 0` | L5 | both | It catches an over-blocking fix of M58–M60. |
| M66 | expiry not checked at start | L9 (permit): tool calls `0 → 1` | L9 | both | — |
| M67 | reject not final | L10: approve after reject `not_pending → ok` | L10 | check and lifecycle | — |
| M68 | approval fence before the provider callback (the B1 class) | L1 variant with the revocation inside the provider: approval `pending → approved` | L1-provider | check and lifecycle | The issue fence still denies. |

The permit-path counterparts of M12–M14 and M24 are also run in the runtime suite (L1, L2, L3, L4a), so that each lifecycle check point has a runtime-own witness.

### 8.3 Adapter mutants

| Mutant | Defect | Detection |
|---|---|---|
| AM14 | The adapter refuses `start` itself when it believes no permit exists (it never calls the runtime) | no call record for the step: `decision_without_evidence` |
| AM15 | The adapter issues (or approves) a lineage at setup that the case declares `pending` | the first probe shows the lineage `approved`/`issued` against `initial: pending`: `identity_mapping_invalid` |
| AM16 | The adapter reports `permit_issued` / `approval_granted` from the call's return or the audit, not from the lineage snapshot | `effect_without_probe_evidence` when the snapshot does not show it (injected as for AM3/AM6) |
| AM17 | One lineage shared by two authorities, or one authority mapped to two lineages | `identity_mapping_invalid` |
| AM18 | The adapter consumes, issues or revokes on the runtime's behalf (for example it re-issues after a denied start) | a new probe-log check: every lifecycle transition must occur at a step whose own runtime call can produce it (`lifecycle_transition_mismatch`), analogous to `revocation_target_mismatch` |

The adapter never grants, issues, consumes or revokes a permit on the runtime's behalf. It only maps contract operations to runtime calls and reads lineage state.

## 9. What the adapter must not do

- Keep its own pending, approved, issued or consumed state, or deny `approve`, `issue` or `start` because of it.
- Mint, issue or consume a permit, or start a tool, outside the runtime's `start()`.
- Derive `approval_granted`, `permit_issued` or `execution_started` from receipts, return values or audit records.
- Map one contract `revoke` to several lineage or scope operations, or revoke on the runtime's behalf.
- Re-create a lineage after a denial (a regrant). The contract defines no regrant.

## 10. Implementation sequence

Each step is reviewed and authorized separately. This plan authorizes none of them.

1. **Runtime lifecycle and API** (`acs-guardrail-demo`):
   - permit mode;
   - lineage records and the bindings of §3.2;
   - `ApprovalGrantV3`;
   - `approve`, `reject`, `issuePermit`, `start` and the reads;
   - the receipt extension and the shared authority sequence;
   - the `issue` revocation stage;
   - the effective points of §5.4;
   - tests L1–L14 and the component tests;
   - documentation, CHANGELOG, OCSF allowlist additions;
   - the legacy-mode suite unchanged.

   Gate: `npm run verify`, with the new baseline counts.
2. **Security and mutant gates** (runtime):
   - `mutants/lifecycle/manifest.json` with M53–M68 and the runtime-side witnesses of M12–M14, M24, M25 and M49–M52;
   - the masking analyses of §8.2;
   - recorded gaps (M55, M56);
   - gate regressions in the style of R1–R4;
   - the existing tenant and ancestor gates re-run unchanged.
3. **Runtime release** (for example v0.6.0): release PR, validation, annotated tag and GitHub release, in the same way as v0.5.0.
4. **Eval** (`agent-control-evals`):
   - new lock;
   - profile v4: classifier capability rules for lifecycle and single use, read from the profile;
   - golden profile (23/4, K = 57);
   - adapter mapping (§7.2) and runtime-observation format 3;
   - supplement v3 (S1–S14, with S1/S2/S7/S8 re-mapped, §12);
   - eval mutants M12–M14, M24, M25 and M49–M52;
   - adapter mutants AM14–AM18;
   - re-verification of M1–M37 and AM1–AM13 under permit mode;
   - gate regressions;
   - runtime gate evidence for the new manifest;
   - determinism and recorded-evaluation comparisons;
   - CI on Node 22 and 24.

## 11. Open design decisions (recommendations; not authorizations)

| # | Decision | Recommendation | Alternative and cost |
|---|---|---|---|
| D1 | Scope of permit mode | All tools: in permit mode `process()` never starts; Guardian ALLOW creates an `approved` lineage (approver `policy`) | ASK tools only: M14 then needs ASK tools and single use would not hold for ALLOW tools. This contradicts the contract's "start consumes the single-use permit". |
| D2 | `initial: issued` authorities | Created at setup through the runtime API (process, approve, issue), not assessed | A signed pre-issued permit in the grant, which needs a second issuance path and a second mutant set |
| D3 | `resolveApproval()` in permit mode | Rejected with `LifecycleModeError`; unchanged in legacy mode | Approve-only in permit mode: one method with two meanings by mode |
| D4 | Lineage handle | `start` and `issuePermit` take `lineage_id`; `permit_id` is for observation only | `start(permit_id)`: a start before issuance would have nothing to name, so the adapter, not the runtime, would decide `permit_not_issued` (forbidden emulation) |
| D5 | Argument binding | Exact `arguments_digest` equality | No argument binding: the human would approve a tool rather than an action |
| D6 | Consumption point | Only at the final start guard (no reservation) | A `reserved` state at the early check gives earlier denial of concurrent attempts, but needs release rules that reopen the race |
| D7 | Denied operations | Change no lifecycle state (except observed expiry), including approval-fence denials | Today's "fail destroys the pending action" behaviour: simpler, but a transient provider error would destroy a valid approval, and a mismatching attempt could burn a permit |
| D8 | Expiry | Evaluated at operations and recorded by them; reads report stored state and `*_expires_at` | Derived at read: snapshots would change without any operation, which blurs the effect step |
| D9 | Approval grant | `ApprovalGrantV3` (`lineage_id`, `request_digest`, `authority_fingerprint`) required in permit mode | V2 without request or authority binding |
| D10 | Guardian at start | Not re-evaluated; the decision is bound at lineage creation, and start compares bindings | Re-evaluate and require the same decision: only useful once policies become stateful |
| D11 | Mode combination | Permit mode independent of tenancy mode; the eval pin uses both | Permit mode requires tenancy mode |
| D12 | Evidence kind for lifecycle state | A separate `lifecycle_effect` label, never counted as containment | Count lifecycle records as `containment_effect`: an approval record is no contained effect, and this would inflate containment evidence |
| D13 | Ordering evidence | One shared authority sequence for revocation, approval, issue and consumption | Separate counters: the order of an approval and a revocation could not be shown |
| D14 | Loser reason of concurrent starts | `permit_consumed` | A separate `permit_in_use`: there is no in-use state without D6's reservation |
| D15 | Revocation receipt | Add `pending_lineages`, `approved_lineages`, `unused_permits` (additive) | No change: the cut's reach into the lifecycle would not be visible |
| D16 | Approval and permit TTL | Approval TTL from `ask_details.timeout_seconds` (as today); permit TTL a constructor option, capped by the chain's validity end | Unbounded permits, which outlive their authority window |

## 12. Compatibility and migration

- **Runtime.**
  - Legacy mode stays the default and is unchanged: `process()` and `resolveApproval()` keep their signatures, behaviour, audit events and V2 grants.
  - Permit mode is opt-in, and its methods throw `LifecycleModeError` in legacy mode.
  - Additive changes:
    - the `ProcessResult` gains `lineage_id` in permit mode;
    - the revocation receipt gains three lists;
    - `RevocationStage` gains `issue`;
    - the audit sequence and OCSF allowlists gain the lifecycle events and fields.
  - `ExecutionGate` is unchanged.
  - **Migration for integrators who opt in:**
    - switch to `approve()`, `issuePermit()` and `start()`;
    - issue `ApprovalGrantV3` grants;
    - persist nothing: lifecycle state stays in memory and single-instance, like revocation.
- **Eval.**
  - A new pin, profile and observation format (3). The recorded format 1 (a682e44) and format 2 (a9deab6) observations stay re-evaluable under their historical locks.
  - Supplement cases S1, S2, S7 and S8 use today's approve-and-start (`approve_starts`). Under permit mode they are re-mapped to approve, issue and start steps in a supplement version 3 with new golden hashes. S3–S6, S9 and S10 keep their content.
  - All existing eval witnesses (M1–M11, M15–M37) and adapter mutants (AM1–AM13) are re-verified under permit mode before the pin is accepted. Single use cannot mask them by itself (§6), but the exact values are pinned again.
- **Contract.** No change to `revocation-0.4.0`. The lifecycle realizes the contract's existing `approve`, `issue` and `start` semantics. Expiry and reject are runtime-specific and appear only in runtime-own tests.

## 13. What this PR does not change

No runtime, adapter, schema, corpus, supplement, profile, lock or CI change. No G5–G7 work. The coverage figures above are a plan computed with the current classifier; they become binding only through the reviewed eval step of §10.
