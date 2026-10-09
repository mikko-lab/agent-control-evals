# Runtime adapter compatibility — revocation track, `acs-guardrail-demo` @ `a682e44`

Status: **specification for review**. This document defines how a pinned runtime adapter would be evaluated against the revocation contract. It changes no adapter, schema, corpus, version number or pin. It also prepares the `revocation-0.4.0` contract changes the adapter needs. The integration work order follows only after this document has been reviewed.

| | |
|---|---|
| Contract today | `revocation-0.3.0` (`docs/revocation/evaluation-spec.md`), corpus of 27 cases, golden `corpus/revocation/smoke.sha256` |
| Runtime target | `mikko-lab/acs-guardrail-demo` commit `a682e4479dbccd1cd5f665f5d4879bd3dddb8b47` (merge of `mikko-lab/acs-guardrail-demo#10` into `b48f482`), tree `1346e92e64aff16183df84ea126271644498190a`, `package.json` version `0.4.0` |
| Runtime capabilities used | A1 authority revocation (`GuardedExecutor.revoke`, `RevocationReceiptV1`, request/approval/start/delivery fences) and A2 cooperative containment (`ExecutionContext`, `ctx.commit`, `ctx.track`, `acknowledgeCancellation`, `getExecution`, `terminals`, `whenTerminal`, `managedState`) |
| Unchanged | `sut.lock.json` (ACS track, `403d315`), `reports/v0.1/`, the ACS adapter and its accepted baseline, the synthetic revocation self-test |

## 1. Pinning: `sut.revocation.lock.json`

The revocation track gets its own lock. `sut.lock.json` remains the lock of the ACS v0.1 track, and its accepted baseline is not re-run, rewritten or reinterpreted. The two pins name different commits of the same repository, and each commit is a different SUT for the track that uses it.

### 1.1 Content (to be created in the integration phase, not now)

```json
{
  "track": "revocation",
  "contract": "revocation-0.4.0",
  "sut": "acs-guardrail-demo",
  "sut_repository": "https://github.com/mikko-lab/acs-guardrail-demo",
  "sut_commit": "a682e4479dbccd1cd5f665f5d4879bd3dddb8b47",
  "sut_tree": "1346e92e64aff16183df84ea126271644498190a",
  "sut_version": "0.4.0",
  "sut_package_lock_sha256": "acef66c720934d35add73e53269d0bf8618cc84646dbbb2d92cefe1f1ff91829",
  "approved_via": "mikko-lab/acs-guardrail-demo#10 merge commit; technical approval of head e3e2746",
  "baseline_at_pin": { "test_suites": 28, "tests": 553, "ci_node_versions": [22, 24], "verify_command": "npm run verify" },
  "profile": "profiles/revocation/acs-guardrail-demo-a682e44.profile.json",
  "follow_upstream": false
}
```

The commit SHA (with its tree) is the SUT identity. `sut_version` is **not** an identity: it is `0.4.0` at both `403d315` and `a682e44`. It is only checked for consistency.

### 1.2 Loading and commit verification

The loader follows the existing ACS pattern (`src/sut/checkout.ts`, `src/sut/lock.ts`), generalised so the lock file name is passed explicitly. A track never falls back to the other track's lock. Every step below fails closed: the evaluation does not run, and the CLI exits with code 2.

1. **Parse the lock.** Check that `sut_commit` and `sut_tree` are full 40-hex SHAs, `follow_upstream` is `false`, `track` is `revocation`, and `contract` equals the harness version.
2. **Fetch the commit.** Use a read-only bare mirror (push URL disabled) and fetch exactly `sut_commit`. No branch or tag name is resolved.
3. **Check out a fresh worktree.** It must be detached at `sut_commit` with the remote removed. It lives in a revocation-specific work directory and is never shared with the ACS track or reused across mutants.
4. **Verify the checkout.** All of the following must hold:
   - `git rev-parse HEAD` equals `sut_commit`;
   - `git rev-parse HEAD^{tree}` equals `sut_tree`;
   - the worktree is clean, including untracked files;
   - the SHA-256 of `package-lock.json` equals `sut_package_lock_sha256`;
   - the `package.json` version equals `sut_version`.
5. **Install and build.** Run `npm ci` and the SUT's own TypeScript build in the checkout. The SHA-256 of every compiled SUT module the adapter loads is recorded.
6. **Verify the baseline (optional).** `npm run verify` must reproduce `baseline_at_pin`. A mismatch is reported and blocks acceptance.
7. **Load the SUT.** Only these exports are loaded: `GuardedExecutor`, `AuthorityRevokedError`, `ReplayGuard`, `ReplayGuardError`, `ManagedStateStore` types, `CommitRejectedError`, `CancellationError`, the `tools` registry, and the signing, verification and audit classes needed to build signed requests. The adapter never patches, re-exports or extends SUT modules.

### 1.3 Binding into the report and manifest

Every runtime-adapter report records a `sut` block with:
- `repository`, `commit`, `tree`, `version`;
- `lock_sha256`: the bytes of `sut.revocation.lock.json`;
- `build_sha256`: a hash over the loaded compiled modules;
- `baseline_verified`: true or false.

It also records a `profile` block with `id` and `sha256`, the `harness_commit`, and `observation_source: "pinned_runtime_adapter"`. The manifest's implementation list additionally covers:
- the lock file;
- the profile file;
- the adapter modules;
- the compiled SUT module hashes.

A report whose `sut.commit` differs from the lock, or whose profile hash differs from the committed profile, is refused by validation.

## 2. Capability profile and applicability

### 2.1 Two separate axes

**Applicability** is decided per case **before** any runtime is invoked or any observation is read. It is not a verdict.

| Applicability | Meaning |
|---|---|
| `IN_PROFILE` | Every SUT requirement of the case (§2.3) is expressible against the runtime, either directly or through a declared harness construction (§3). |
| `OUT_OF_SCOPE` | At least one SUT requirement of the case needs a capability the runtime does not offer. The case has **no verdict**, is never PASS, and is never executed against the SUT in 0.4.0. |

**Verdicts** apply only to `IN_PROFILE` cases, and keep the `revocation-0.3.0` meaning:

| Verdict | Meaning |
|---|---|
| `PASS` | All assessed requirements were observed as the contract requires. |
| `VIOLATION` | Confirmed decision or effect findings. |
| `UNASSESSABLE` | The case is in the profile, but required evidence is missing: an UNKNOWN decision, a barrier timeout, an unsealed or drifting observation, or a missing terminal (including `unobservable`, §4.5). |
| `HARNESS_ERROR` | The harness or adapter broke the contract: schema violation, unattributable effect, causally impossible trace, a decision reported for a control step, an observation supplied for an `OUT_OF_SCOPE` case, or a profile/lock binding mismatch. |

`OUT_OF_SCOPE` is not `UNASSESSABLE`. The first means the runtime lacks the capability, as declared before the run. The second means a capability the runtime offers left no evidence in this run. A case never moves between the two because of what happened during the run.

### 2.2 How the profile is fixed

- **Versioned file.** The profile is a committed, versioned file (§6), bound to one lock (`sut_commit`) and one contract version.
- **Deterministic classifier.** Applicability is computed by a classifier that reads only the corpus, the oracle's expectations and the profile's capability rules, never observations or reports. The committed per-case list in the profile is golden-checked against that output. A disagreement fails the build.
- **Changes need a new profile.** Any change to the capability rules or the case list is a new profile version and requires review. It cannot be changed by a CLI flag or by an observation file.
- **Order of operations.** The CLI computes applicability, then all oracle expectations, before it invokes the adapter or reads observations, as `revocation-cli.ts` already does for the oracle.

### 2.3 What counts as a requirement

Every expected decision and every expected effect of a case is one requirement, and each is classified as:

- **D (direct):** the runtime itself makes the decision or produces the effect through its public API or state.
- **C (construction):** the runtime makes the decision or produces the effect, but *when* the triggering operation happens is set by a declared harness construction (§3.3).
- **O (out of scope):** the runtime has no corresponding capability. A single O requirement makes the whole case `OUT_OF_SCOPE`.
- **K (harness control):** the decision of a `finish` or `seal` step. In this profile these steps are harness commands, not SUT operations (§3.2), so the SUT cannot make a decision for them. K decisions are **not assessed**. They are listed per case in the report, and the adapter must not report them (§4.1).

Treating K as "not assessed" rather than O is a deliberate, uniform reduction declared in the profile. It is the reason a profile result is never a contract result. A stricter reading would treat K as O, which would make all 27 cases `OUT_OF_SCOPE`, because every case has a `finish` and a `seal`. This choice is open review decision **R1** (§10).

A case that is partially implementable is `OUT_OF_SCOPE` as a whole. Its expressible requirements are listed but not evaluated, so they can never add up to a PASS.

### 2.4 Report content (both modes)

The report always lists **all 27 corpus cases**. Each entry carries:
- `applicability`;
- for `OUT_OF_SCOPE` cases, `out_of_scope` as a list of `{ step, requirement, capability_class, reason }`;
- `not_assessed_control_steps`;
- the existing evidence fields, with `verdict: null` for `OUT_OF_SCOPE`.

Counts:

```
corpus_total            27
in_profile              N
out_of_scope            27 - N
PASS / VIOLATION / UNASSESSABLE / HARNESS_ERROR   over in_profile only
corpus_coverage         N / 27
profile_pass_rate       PASS / N
contract_acceptance_passed   PASS == 27        (always false while any case is OUT_OF_SCOPE)
profile_acceptance_passed    PASS == N, N > 0, technically valid
has_confirmed_violation      as in 0.3.0
```

`summary.md` starts with a fixed statement whenever `out_of_scope > 0`:

> Declared-profile result for `<profile id>` on `<sut>@<commit>`: N of 27 cases in profile, PASS P of N. **This is not a revocation-0.4.0 contract pass.** 27 − N cases are OUT_OF_SCOPE, and finish/seal decisions are not assessed.

### 2.5 Full-contract mode vs declared-profile mode

| | Full-contract mode (default) | Declared-profile mode (`--profile FILE` together with `--lock FILE`) |
|---|---|---|
| Who uses it | Synthetic self-test and any adapter claiming the whole contract | A runtime adapter with an explicitly selected, committed profile |
| Cases requiring observations | All 27 | Exactly the `IN_PROFILE` cases. An observation for an `OUT_OF_SCOPE` case is an input error. |
| Control-step decisions | Required (as in 0.3.0) | Must be absent. If present, the case is a HARNESS_ERROR (`decision_at_control_step`). |
| Acceptance | `contract_acceptance_passed` | `profile_acceptance_passed`. `contract_acceptance_passed` is still reported. |

**`evaluate` exit codes (0.4.0)**, applied in the order listed:

| Exit | Condition |
|---|---|
| 2 | Input, usage, lock or profile binding error; or a technically invalid or incomplete evaluation (any HARNESS_ERROR or UNASSESSABLE case), also when confirmed violations were retained |
| 1 | Technically valid with at least one VIOLATION |
| 3 | Declared-profile mode: profile accepted (all `IN_PROFILE` cases PASS) but at least one `OUT_OF_SCOPE` case. **Not a contract pass.** |
| 0 | All 27 cases assessed and PASS. Possible in full-contract mode, or in a profile with no `OUT_OF_SCOPE` case. |

Exit 0 is reserved for full-contract acceptance, so a CI gate written for 0.3.0 cannot mistake a partial profile for a contract pass. `self-test` keeps its 0.3.0 semantics (full-contract mode).

## 3. Command and effect correspondence

### 3.1 Identity mapping (fixed per case, before the run)

| Contract identity | Runtime identity | Class |
|---|---|---|
| Tenant/session pair `(t, s)` | One runtime `session_id` per pair, unique within the case | C (the runtime has no tenant. Tenants are only a namespace for session ids.) |
| Authority `x` (initial `issued`) | One signed capability grant with its own `capability_id`, valid for the whole case under a fixed clock, bound to the authority's session and one tool. **One signed tool-call request** `R_x` is bound to that grant. | C |
| Authority with initial `pending` | none | O |
| Authority `parent` link | none (no derived authority in the runtime) | O when a revocation's coverage depends on it (§3.4) |
| Execution label `e` | The runtime `execution_id` (`exec-<n>`) delivered to the tool double as `ctx.execution_id` when the runtime starts the execution. The adapter records `label → execution_id` only from this runtime-issued value. | D (runtime-assigned) |
| A label never started by the runtime | No runtime identity | Operations on it other than `finish` are O |

**Authority–capability binding.** The runtime binds a managed execution to the `capability_id` it was authorised under, and binds each `capability_id` to the content of the first grant seen with it (A1 `capability_id_conflict`). The adapter:
- gives every authority a distinct `capability_id` and session;
- returns the identical grant object from the capability provider for every resolution of that authority's request;
- uses a fixed clock and grant lifetimes that cover the whole case, so expiry can never masquerade as revocation.

On every observation of an execution (start, each later step, terminal), the adapter checks that the runtime snapshot's `capability_id` and `session_id` equal the authority's original grant. Effects are attributed from the **runtime's** binding (`capability_id → authority`), never from the authority the harness intended. A binding naming no known capability is an unattributable effect (HARNESS_ERROR). A binding naming another known authority is reported under that authority and judged by the evaluator.

### 3.2 Commands

| Contract command | Runtime operation | Decision source | Class |
|---|---|---|---|
| `revoke` authority-scope target `x` | `executor.revoke({ scope: "capability", capability_id: cap(x) })` | Receipt returned → ALLOW; `RevocationTargetError` or another throw → DENY | D, when `x` has no descendants in the case (§3.4); otherwise O |
| `revoke` session-scope `(t, s)` | `executor.revoke({ scope: "session", session_id: sid(t, s) })` | as above | D |
| `revoke` tenant-scope | none (the runtime rejects tenant scope) | none | O |
| `approve` | none as a separate operation. The runtime's approval (`resolveApproval`) also starts the execution, in the same call. | none | O |
| `issue` | none. Permits are minted inside the runtime's start path (`ExecutionGate.mintPermit`) and are not observable or invocable separately. **The adapter must not mint, simulate or report a permit itself.** | none | O |
| `start x/e` (first start of `x`) | `executor.process(R_x)` with a tool that needs no approval | ALLOW: the runtime invoked the tool double with a fresh `ExecutionContext`, **and** `getExecution(ctx.execution_id)` exists. DENY: `process()` rejected with `AuthorityRevokedError` or `ReplayGuardError` before the double was invoked. Any other outcome (`status: "pending"`, another error type, a watchdog timeout) → UNKNOWN, with the runtime error class and message recorded as a diagnostic. | D |
| `start x/e'` (later start of `x`, fresh label) | Re-submit the **same** signed request `R_x` | as above. The runtime's replay guard (or an earlier revocation) is what denies it. | C: request-level single use; see R2 |
| `start y/e` with a label already in use by `x` | none (the runtime assigns execution ids itself) | none | O |
| `commit x/e` (label started by the runtime) | The harness calls the retained `ctx.commit(key(e), value)` synchronously, at the step | `CommitReceipt` → ALLOW; `CommitRejectedError` → DENY (the runtime reason is recorded as a diagnostic); `TypeError` → HARNESS_ERROR (an adapter defect) | D. Calling the retained context after the tool function has settled is C (detached-work pattern, as in the runtime's C13). |
| `commit` on a label the runtime never started | none (there is no context) | none | O |
| `deliver x/e` before `finish x/e` | The harness fulfils the tool double's returned Promise with the per-execution output nonce `out(e)`. That makes the runtime process the result and reach its delivery fence. | Public promise of `process()` fulfils with `exit_status: "success"` carrying `out(e)` → ALLOW. Fulfils with `exit_status: "blocked"` and code `session_revoked` or `capability_revoked` → DENY. Anything else → UNKNOWN. | C (trigger), D (decision) |
| `deliver x/e` after `finish x/e` | none. The tool function has already settled at `finish`, and the runtime has no later delivery operation. | none | O |
| `cancel_ack x/e` | The harness calls the retained `ctx.acknowledgeCancellation()` at the step | `true` → ALLOW; `false` → DENY, with the snapshot (`cancellation_requested`, `cancellation_acknowledged`, `state`) recorded as a diagnostic | D within the construction; see §3.5 |
| `finish x/e` | Harness control: release the execution's registered-work lock, and if the tool function's Promise is still pending, reject it with the harness error `HarnessFinish` | none. **K: no SUT decision is reported.** | K (decision), C (timing of the terminal) |
| `seal` | Harness control: final quiescence check (§4.3) | none. K. | K |

### 3.3 The registered-work construction (terminal timing)

At start, the tool double:
1. registers one harness-owned native Promise `L(e)` through `ctx.track(L(e))`;
2. returns another harness-owned native Promise `M(e)`, which it does not settle itself;
3. never reads the cancellation signal on its own.

Both Promises are plain intrinsic Promises, so the runtime can observe them.

- `deliver` settles `M(e)` (fulfil). `finish` settles `L(e)`, and also `M(e)` (reject with `HarnessFinish`) if it is still pending.
- The runtime records the terminal only after it has observed, through the intrinsic `then`, that `M(e)` and `L(e)` have both settled. With this construction that happens in the `finish` step, which is within the contract's terminal window: at or after the covering revocation, or at or after the finish request.

**What the runtime actually controls here, and what a passing case shows:**

- It shows that the runtime does not report a terminal before it has observed the settlement of the tool function and of all registered work, and that it does report one afterwards. A terminal at `deliver` (before `finish`) would be `unexpected_execution_terminal` in `commit-before-cut`.
- It shows that the runtime's commit fence and cancellation reach a running or draining execution, and that the terminal closes the commit fence (`execution_terminal`).
- It does **not** show that the runtime stops work. Here the harness ends the work, and the runtime only observes it.
- It does not show anything about tools that do not cooperate, effects outside `ctx.commit()`, or work that is not registered.
- The step of the terminal is chosen by the harness. It is evidence of the runtime's observation and recording, not of containment latency.
- The construction never exercises a tool that ends on its own when cancelled. That runtime behaviour (terminal before `finish`) is outside the construction.

### 3.4 Revocation coverage and descendants

The contract's authority-scope revocation covers the target and all its descendants. The runtime's capability-scope revocation covers exactly one `capability_id`. An authority-scope revoke is therefore D only when its target has **no descendants** in the case's predeclared authority tree (checked by the classifier). Otherwise it is O. Parent links that no revocation depends on (for example the parent of a revoked leaf in `sibling-isolation`) are not modelled. Such a case then shows isolation between independent capabilities, not tree semantics (R3).

### 3.5 Specifics requested for review

- **`issue`:** O for this runtime. The adapter never mints or reports a permit, and never presents a harness action as a runtime decision. Initial `issued` authorities are expressed only as a valid grant plus an unsent request, which corresponds to the grant states `issued` and `consumed`. No `approved`-but-not-`issued` state exists.
- **`finish`:** releasing the lock is a harness command with no SUT decision (K). The terminal is a separately observed runtime state: `getExecution().state === "terminal"`, an entry in `terminals()`. It is never inferred from the lock release.
- **`deliver`:** the fulfilment of the public Promise and the execution terminal are independent runtime events, and their order is not fixed. With the construction, a `deliver` before `finish` fulfils the public Promise while the execution is still `draining`, and the terminal follows at `finish`. When `finish` comes without `deliver`, both events happen in the `finish` step, in either order. The tool double's rejection means the public Promise carries no output nonce, so no `output_delivery` is observed. The adapter binds each event to the step whose barrier it appeared in (§4.2), never to its order relative to the other.
- **`cancel_ack`:** within the construction, every `cancel_ack` in an `IN_PROFILE` case reaches an execution that is running or draining, after a covering revocation, and before `finish`. There the runtime's `acknowledgeCancellation()` returns `true` exactly when the contract expects ALLOW. **A direct correspondence is not established in general:**
  - The runtime returns `false` for an execution that is already terminal. The contract still expects ALLOW for a bound execution whose finish has not been requested, for example one that ended at its revocation.
  - The runtime returns `false` when no cancellation was requested. The contract does not require a prior revocation.

  Neither situation is reachable in the construction or in the corpus. Both are declared in the profile as unsupported capability classes, `cancel_ack_after_runtime_terminal` and `cancel_ack_without_cancellation_request`. Integration adds one adapter conformance test that pins the runtime's `false` for an already-terminal execution, so the divergence is documented rather than assumed (R4).
- **Authority–capability binding:** see §3.1. Each authority keeps one original grant for the whole case. Re-submitting `R_x` reuses that grant, and the runtime's execution record must show the same `capability_id` at every observation.

### 3.6 Effects

| Contract effect | Observation | Source | Class |
|---|---|---|---|
| `revocation_ack` (target) | The receipt returned by `revoke()`, `status` `revoked` or `already_revoked`. Its `target` is mapped back (`capability_id → authority`, `session_id → (t, s)`). A receipt target that maps back to a different contract target is reported as such. | `sut_api` | D |
| `approval_granted`, `permit_issued` | none | none | O |
| `execution_started` | Tool double invoked with a fresh context (`harness_observation`) **and** `getExecution(id)` exists with the authority's binding (`sut_state`) | both | D |
| `tool_commit` | `managedState.version` increments and `managedState.get(key(e))` holds the value (`sut_state`). Cross-checked against the returned `CommitReceipt.execution_id` (`sut_api`). A state change without a receipt, or a receipt without a state change, is a HARNESS_ERROR (inconsistent evidence). | `sut_state` primary | D |
| `output_delivery` | Public `process()` promise fulfilled with `exit_status: "success"` and `out(e)` | `sut_api` | C (trigger), D (effect) |
| `cancellation_ack` | `acknowledgeCancellation()` returned `true` **and** the snapshot's `cancellation_acknowledged` flipped from false to true within the step | `sut_api` and `sut_state` | D |
| `execution_terminal` | `getExecution(id).state === "terminal"` with a terminal record, and an entry in `terminals()`. The occurrence step is the step in whose barrier the state first appeared. `whenTerminal()` is used only as a bounded wake-up, never as the evidence itself. | `sut_state` | D (state), C (timing) |

The audit stream is the runtime's own report. It is kept in the bundle as diagnostics and is **not** evidence for any decision or effect, matching the runtime's own A2 test discipline.

## 4. Evidence and timing

### 4.1 Provenance and no back-filling

- **Expectations** come only from the oracle (`expected(c)`), computed before the adapter runs.
- **Observed decisions and effects** come only from the SUT's API return values or exceptions (`sut_api`), the SUT's inspectable state (`sut_state`), or independent harness observation of the tool doubles and public Promises (`harness_observation`). Each observed item carries its provenance.
- **No back-filling.** The adapter never derives a decision or effect from the oracle or the corpus design. It never fills a missing observation, and never reports a decision for a K step. Anything it cannot observe is UNKNOWN or absent and becomes incomplete evidence.
- **Runtime reasons are diagnostics only.** Examples are `AuthorityRevokedError.reason`, `CommitRejectedError.reason`, the withheld `code` and the `ReplayGuardError` class. They are recorded as `sut_reason` diagnostics and never feed the verdict. The contract compares decisions, not reasons, so overdetermined oracle denials (for example `revoked + already_committed`) are matched by any runtime DENY.

### 4.2 Step binding and explicit barriers

Steps run strictly in order. Each step has an action and an explicit completion barrier. An effect is bound to step *i* if it first appears between the start of step *i*'s action and the completion of step *i*'s barrier.

| Op | Barrier (step complete when) |
|---|---|
| `revoke`, `commit`, `cancel_ack` | The synchronous call has returned or thrown. Cancellation listeners run synchronously inside `revoke()`. |
| `start` | The double's entry latch has fired, **or** the public `process()` Promise has settled (whichever event comes first) |
| `deliver` | The public `process()` Promise has settled |
| `finish` | The execution's terminal is present in `getExecution()`, **and** the public Promise has settled if it was still pending |
| `seal` | One macrotask turn (`setImmediate`) has completed after the last step, followed by the drift check |

**Drift check.** The adapter snapshots the observable state when each barrier completes:
- `managedState` version and keys;
- every execution snapshot;
- `terminals()`;
- the public Promise states;
- the tool doubles' logs.

It snapshots again immediately before the next action, and once more at `seal`. A difference means an effect occurred outside any step's barrier. Its occurrence step cannot be established, so the observation is reported as `complete: false` (UNASSESSABLE), and the drifted item is kept as a diagnostic. A fixed number of microtask turns is never used as a barrier.

**Watchdog.** Each asynchronous barrier has a fixed wall-clock bound, proposed as 2000 ms and declared in the profile. When it expires, the step's decision is UNKNOWN and the observation is `complete: false`. A timeout can only lower a case to UNASSESSABLE. It never produces ALLOW, DENY or an effect, so it cannot change a verdict to PASS or VIOLATION.

### 4.3 Seal and completeness

`complete: true` only if every step's barrier completed, no drift was detected, and the seal quiescence check found no change. After the observation is frozen, the adapter releases any remaining harness locks for cleanup. Effects of cleanup are not observed.

### 4.4 Fresh state per case

Each case gets:
- a new `GuardedExecutor` (with its own managed state store), fresh signing keys and a fresh replay guard;
- a fixed clock and a fresh capability provider;
- per-case tool doubles installed in the SUT's `tools` registry, restored afterwards; `executionCounters` reset.

The adapter's behaviour must not depend on a case's `id` or `family` (as in 0.3.0). It receives only `authorities` and `steps` together with the identity mapping.

### 4.5 `unobservable` and `whenTerminal()`

A managed execution in state `unobservable` (`mikko-lab/acs-guardrail-demo#10`) is an `IN_PROFILE` execution whose terminal evidence is missing. It is UNASSESSABLE, never OUT_OF_SCOPE, and never a `failed` terminal. The adapter:
- does not await `whenTerminal()` without a bound (the `finish` barrier uses the watchdog);
- records `state: "unobservable"` as a diagnostic;
- reports no `execution_terminal`.

With the construction, the harness's own Promises are always observable, so this state can only be reached through a SUT defect or a mutant.

## 5. Case matrix (27 cases)

Step numbers refer to the committed corpus. Abbreviations:
- **ack** = `revocation_ack`;
- **D / C / O / K** as defined in §2.3;
- **K-steps** are the `finish` and `seal` decisions that are not assessed. `seal` is the last step of every case and is always K.

**Summary:** 15 `IN_PROFILE`, 12 `OUT_OF_SCOPE`. Corpus coverage is 15/27.

| # | Case | Family | Applicability | D requirements | C requirements | O requirements (reason) | K-steps (besides seal) |
|---|---|---|---|---|---|---|---|
| 1 | `pending-approval` | pending_approval | OUT_OF_SCOPE | ack@0 | — | initial `pending`; `approve`@1, `issue`@2 (no separate approval/permit operation) | finish@4 |
| 2 | `issue-after-cut` | pending_approval | OUT_OF_SCOPE | ack@1 | — | `approve`@0, `issue`@2 | finish@4 |
| 3 | `issued-permit` | issued_permit | IN_PROFILE | ack@0; start DENY@1 | start DENY@2 (re-submitted `R_a`) | — | finish@3, finish@4 (DENY unbound not assessed) |
| 4 | `fresh-id-retry-unused-permit` | issued_permit | OUT_OF_SCOPE | ack@3 | — | initial `pending`; start DENY `permit_not_issued`@0 (no not-yet-issued state); `approve`@1, `issue`@2 | finish@5, finish@6 |
| 5 | `cut-before-start` | issued_permit | IN_PROFILE | ack@0; start DENY@1 | — | — | finish@2 |
| 6 | `duplicate-revocation` | issued_permit | IN_PROFILE | ack@0; ack@1 (`already_revoked`); start DENY@2 | — | — | finish@3 |
| 7 | `active-session` | active_session | IN_PROFILE | session ack@0; start a DENY@1; start b DENY@2 | — | — | finish@3, finish@4 |
| 8 | `session-in-flight-commit-fence` | active_session | IN_PROFILE | start a@0, start o@1 (+started); session ack@2; commit a DENY@3; commit o ALLOW@4 (+commit) | deliver o ALLOW@5 (+delivery); terminal a ∈[2..8] at finish@6; terminal o at finish@7 | — | finish@6, finish@7 |
| 9 | `session-delivery-fence-after-commit` | active_session | IN_PROFILE | start@0; commit@1; session ack@2 | deliver DENY@3 (withheld); terminal at finish@4 | — | finish@4 |
| 10 | `tenant-multi-session-in-flight` | active_session | OUT_OF_SCOPE | starts@0–2; commit c@6 | deliver c@7 | tenant-scope revoke@3 and its fences@4–5 | finish@8–10 |
| 11 | `start-before-cut` | in_flight_before_commit | IN_PROFILE | start@0; ack@1; commit DENY@2 | terminal at finish@3 (tool Promise rejected by harness, no output) | — | finish@3 |
| 12 | `in-flight-before-commit` | in_flight_before_commit | IN_PROFILE | start@0; ack@1; cancel_ack ALLOW@2 (+cancellation_ack); commit DENY@3 | deliver DENY@4 (withheld; oracle reasons `revoked+not_committed`, runtime explains by revocation); terminal at finish@5 | — | finish@5 |
| 13 | `late-commit-after-terminal` | in_flight_before_commit | OUT_OF_SCOPE | start@0; ack@1 | commit DENY@3 (retained context after terminal) | `deliver`@4 after `finish` (no runtime delivery operation after the tool function settled) | finish@2 |
| 14 | `retry-after-revocation` | in_flight_before_commit | OUT_OF_SCOPE | start@0; ack@1 | start DENY@3 (re-submitted `R_a`) | `commit a/retry`@4 on an execution the runtime never started | finish@2, finish@5 |
| 15 | `in-flight-after-commit` | in_flight_after_commit | IN_PROFILE | start@0; commit@1; ack@2; cancel_ack@3; commit DENY@5 (oracle `revoked+already_committed`; the runtime has no once-only commit rule, so revocation explains it) | deliver DENY@4 (withheld); terminal at finish@6 | — | finish@6 |
| 16 | `commit-before-cut` | in_flight_after_commit | IN_PROFILE | start@0; commit@1; ack@3 (cancellation requested while draining) | deliver ALLOW@2 (+delivery, execution stays draining); terminal ∈[3..5] at finish@4 | — | finish@4 |
| 17 | `commit-shift-across-cut` | in_flight_after_commit | IN_PROFILE | start@0; commit@1; ack@2; cancel_ack@3 | terminal at finish@4 | — | finish@4 |
| 18 | `cancel-is-not-rollback` | in_flight_after_commit | OUT_OF_SCOPE | start@0; commit@1; ack@2; cancel_ack@3 | — | `deliver`@5 after `finish` | finish@4 |
| 19 | `derived-authority` | descendant_scope | OUT_OF_SCOPE | — | — | revoke of `a` must cover descendants `child`, `pending-child`; `approve`@2, `issue`@3 | finish@4 |
| 20 | `derived-in-flight-ancestor-revoked` | descendant_scope | OUT_OF_SCOPE | start child@0 | — | revoke of `a`@1 must fence `child`'s commit@2 (descendant coverage) | finish@3 |
| 21 | `sibling-isolation` | scope_isolation | IN_PROFILE (R3) | ack@0 (target `child` has no descendants); start child DENY@1; start sibling@2; commit sibling@3; start a@7 | deliver sibling@4; terminal sibling at finish@5; terminal a at finish@8 (no output) | — (parent links not modelled) | finish@5, finish@6, finish@8 |
| 22 | `session-isolation` | scope_isolation | IN_PROFILE | session ack@0; start a DENY@1; start other@2; commit other@3 | deliver other@4; terminal other at finish@5 | — | finish@5, finish@6 |
| 23 | `tenant-isolation` | scope_isolation | OUT_OF_SCOPE | starts/commit of `other`@2–3 | deliver other@4 | tenant-scope revoke@0 and its fence@1 | finish@5, finish@6 |
| 24 | `execution-id-reuse` | identity | OUT_OF_SCOPE | start a@0; commit a@4 | — | `start b/e1`@1 (client-chosen execution id); `commit b/e1`@2 on an execution the runtime never started | finish@3, finish@5 |
| 25 | `permit-single-use` | control | IN_PROFILE (R2) | start@0; commit@2 | start DENY@1 (re-submitted `R_a`, replay guard); deliver@3; terminal at finish@4 | — | finish@4, finish@5 |
| 26 | `approval-before-cut` | control | OUT_OF_SCOPE | ack@6 | — | initial `pending`; `approve`@0, `issue`@1 | finish@5 |
| 27 | `deferred-terminal-before-seal` | observation_timing | IN_PROFILE | start@0; ack@1; cancel_ack@2 | terminal ∈[1..5] at finish@3; commit DENY@4 (retained context; runtime reason `execution_terminal`, oracle `revoked+finish_requested`) | — | finish@3 |

Requirements listed in the D and C columns of an `OUT_OF_SCOPE` row are informational only. They are not run and not evaluated in 0.4.0 (R5).

**Coverage of the design claims within the profile:**
- **Sole-revocation fences:** start (authority, session), commit (authority, session) and delivery (authority, session).
- **Not covered:** approve, issue, the descendant and tenant fences, and the identity fences.

The report lists these uncovered fences explicitly, next to the coverage ratio.

## 6. Proposed capability profile

The profile would be committed in the integration phase as `profiles/revocation/acs-guardrail-demo-a682e44.profile.json`, with a golden SHA-256. Sketch:

```json
{
  "profile": "acs-guardrail-demo-a682e44/revocation-0.4.0/1",
  "contract": "revocation-0.4.0",
  "corpus_sha256": "<current golden corpus/revocation/smoke.sha256>",
  "sut_lock": { "file": "sut.revocation.lock.json", "sut_commit": "a682e4479dbccd1cd5f665f5d4879bd3dddb8b47" },
  "control_ops": ["finish", "seal"],
  "supported": {
    "revoke": { "scopes": ["authority_without_descendants", "session"] },
    "start": { "first_start": "process(R_x)", "later_start_same_authority": "resubmit R_x" },
    "commit": { "on": "execution started by the runtime", "after_terminal": "retained context" },
    "deliver": { "before_finish": true },
    "cancel_ack": { "after_covering_revocation_before_finish": true }
  },
  "unsupported_classes": [
    "initial_pending_authority", "approve", "issue",
    "tenant_scope_revocation", "descendant_coverage",
    "client_chosen_execution_id", "operation_on_execution_unknown_to_runtime",
    "deliver_after_finish",
    "cancel_ack_after_runtime_terminal", "cancel_ack_without_cancellation_request",
    "commit_once_only_sole_denial", "deliver_requires_commit_sole_denial"
  ],
  "barrier_watchdog_ms": 2000,
  "cases": [
    { "id": "issued-permit", "applicability": "IN_PROFILE", "not_assessed_control_steps": [3, 4, 5] },
    { "id": "pending-approval", "applicability": "OUT_OF_SCOPE", "out_of_scope": [
      { "step": 1, "requirement": "decision", "capability_class": "approve", "reason": "approval and start are one runtime operation" }
    ] }
  ]
}
```

The `cases` list is truncated here. The full list has all 27 entries matching §5 and is golden-checked against the classifier. The last two unsupported classes are reached by no corpus case. They are declared so that a future corpus case with a sole `already_committed` or `not_committed` denial is classified `OUT_OF_SCOPE` instead of producing a false VIOLATION.

## 7. Changes proposed for `revocation-0.4.0`

The corpus and its golden SHA are unchanged. Full-contract semantics are unchanged from 0.3.0, apart from the version string.

| Area | Change |
|---|---|
| Model (`src/spec/revocation/model.ts`) | Add the `Applicability` type (`IN_PROFILE`, `OUT_OF_SCOPE`), a `Profile` type, `control_ops`, and the requirement classes `D`/`C`/`O`/`K` |
| Classifier (new) | A pure function `(corpus, oracle, profile rules) → applicability`, with a golden test against the committed profile. It never imports observation or report code (extends `check:oracle-boundary`). |
| Observation schema | `observation_source: "pinned_runtime_adapter"`. Per-item `provenance` (`sut_api` / `sut_state` / `harness_observation`), required for that source. Optional `diagnostics` (`sut_reason`, drift items, unobservable state) that never feed the verdict. Decisions at control steps must be absent in declared-profile mode. |
| Evaluator | Profile-aware. Skips K decisions; a supplied K decision → HARNESS_ERROR `decision_at_control_step`. An observation for an `OUT_OF_SCOPE` case → input error. `OUT_OF_SCOPE` evidence entries carry `verdict: null`. |
| Report schema and summary | `sut` and `profile` blocks; `applicability`, `out_of_scope` and `not_assessed_control_steps` per entry; the split counts of §2.4; `contract_acceptance_passed` and `profile_acceptance_passed`; the fixed non-contract statement; a list of uncovered design fences |
| CLI | `evaluate --profile FILE --lock FILE` (declared-profile mode) and a new `run-adapter` command that drives the pinned runtime. The exit codes of §2.5, including 3. The self-test stays in full-contract mode. |
| Manifest | Adds the lock, profile, adapter modules and compiled SUT module hashes |
| Limitations | Replace "no pinned ACS or production runtime integration" with a statement of the declared profile and its exclusions. Keep "not a production latency claim". State that terminal timing in the profile is harness-chosen, and that the audit stream is not evidence. |

## 8. Integration acceptance criteria

1. **Fail-closed pinning.** Pin verification fails closed on a wrong commit, a wrong tree, a dirty worktree, a mismatched `package-lock.json` hash, or a profile/lock mismatch. A test exists for each.
2. **ACS track untouched.** `sut.lock.json`, `reports/v0.1/` and the ACS adapter are byte-unchanged, and the existing ACS and automotive tests pass unchanged.
3. **Self-test unchanged.** The synthetic revocation self-test passes in full-contract mode, the corpus golden SHA is unchanged, and all existing revocation tests and regressions pass (migrated to 0.4.0 only where the version string requires it).
4. **Classifier and profile.**
   - The classifier output equals the committed profile: 15 `IN_PROFILE` and 12 `OUT_OF_SCOPE` as in §5, unless review decisions R1–R3 change it.
   - A test proves the classifier cannot read observations: it is called before the adapter, and nothing is passed from it.
5. **Baseline at `a682e44`, declared-profile mode.**
   - All 15 `IN_PROFILE` cases PASS, and the run is technically valid.
   - The exit code is 3.
   - The report lists all 27 cases, with coverage 15/27, pass rate 15/15, `contract_acceptance_passed: false` and the fixed statement.
6. **Determinism.** Two consecutive runs produce byte-identical `observations.json`, `evidence.jsonl` and `report.json`. This requires no timestamps in observations and a fixed clock.
7. **Barrier discipline.**
   - Tests show that a delayed effect after a barrier is caught by the drift check (UNASSESSABLE), and that a watchdog timeout yields UNKNOWN and never ALLOW or DENY.
   - No barrier is implemented as a fixed count of microtask turns (enforced by review).
8. **No back-filling.**
   - An adapter test double that copies an oracle decision for a missing observation is caught.
   - A K decision supplied in an observation is a HARNESS_ERROR.
   - Observations for `OUT_OF_SCOPE` cases are rejected.
9. **Binding.** Every attributed effect's runtime `capability_id` and `session_id` equal the authority's original grant at every observation. A test injects a mismatched binding and expects an attribution error or finding, never a PASS.
10. **`cancel_ack` divergence.** A conformance test pins `acknowledgeCancellation() === false` for an already-terminal execution, with that behaviour documented as `cancel_ack_after_runtime_terminal` (R4).
11. **Mutants.** Every SUT mutant of §9 marked as a violation witness is killed by its fixed witness, and every one marked as an incompleteness witness yields UNASSESSABLE for its witness case and exit 2. Mutants marked masked or unreachable are listed in the report as coverage gaps, with no claim that they are detected.
    - Mutants must typecheck in the SUT (`tsc --noEmit`). Each is applied to a fresh checkout and never committed.
    - Witnesses are fixed in the profile review, before any mutant is run.

## 9. Planned mutants

**SUT mutants** are type-safe edits applied to a fresh checkout of `a682e44`. The witnesses below are the expected ones and are to be confirmed when the integration review fixes them.

| ID | Mutation | Expected witness (case @ step: finding) | Kind |
|---|---|---|---|
| M1 | `#maybeTerminal` ignores pending registered work (a premature terminal when the tool function settles) | `commit-before-cut` @2: `unexpected_execution_terminal` | violation |
| M2 | The commit binding check skips `deps.revoked()` | `start-before-cut` @2: `false_allow`, `unexpected_tool_commit` | violation |
| M3 | The commit entry and binding checks ignore the terminal state | None. The only `IN_PROFILE` commit after a terminal (`deferred-terminal-before-seal` @4) is also revoked, so the revocation fence still denies it. Declared **masked** (overdetermined), and recorded as a coverage gap: no `IN_PROFILE` case tests the terminal commit fence on its own. | masked (documented) |
| M4 | `#handOver` and the result-processing delivery check skip revocation | `session-delivery-fence-after-commit` @3: `false_allow`, `unexpected_output_delivery` | violation |
| M5 | `revoke()` does not request cancellation of covered executions | `in-flight-before-commit` @2: `false_deny`, `missing_cancellation_ack` | violation |
| M6 | Session-scope revocation is checked against the capability only | `active-session` @1–2: `false_allow`, `unexpected_execution_started` | violation |
| M7 | Capability-scope revocation also covers every capability of the same session (over-reach) | `sibling-isolation` @2: `false_deny`, `missing_execution_started` | violation |
| M8 | The replay guard accepts a re-submitted request id | `permit-single-use` @1: `false_allow`, `unexpected_execution_started` | violation |
| M9 | The start-path revocation checks (request and start stages) are removed | `cut-before-start` @1: `false_allow`, `unexpected_execution_started` | violation |
| M10 | `#maybeTerminal` never records a terminal | `start-before-cut`: missing terminal → UNASSESSABLE, exit 2 | incompleteness |
| M11 | Restores the pre-PR #10 premature terminal for an unobservable settlement | No `IN_PROFILE` case reaches it, because the construction's Promises are observable. Declared **unreachable** for the corpus; covered by the runtime's own C22b–C22f. | unreachable (documented) |

**Adapter mutants** are defects in the adapter itself. Each must be caught by the adapter's own tests:

| ID | Defect | Expected detection |
|---|---|---|
| AM1 | Fills a missing decision from the oracle | Back-filling test (§8.8) |
| AM2 | Reports a decision for `finish` or `seal` | HARNESS_ERROR `decision_at_control_step` |
| AM3 | Attributes effects to the intended authority instead of the runtime binding | Binding test (§8.9) |
| AM4 | Uses a fixed microtask count instead of the `deliver` barrier | Drift or timeout test (§8.7), UNASSESSABLE |
| AM5 | Treats `whenTerminal()` resolution, or the lock release, as terminal evidence | Test with M10 applied: the result must stay UNASSESSABLE, not PASS |

## 10. Open review decisions

| ID | Decision | Recommendation | Consequence if not accepted |
|---|---|---|---|
| R1 | `finish` and `seal` decisions are K (harness control, not assessed), declared uniformly in the profile | Accept. These steps have no SUT operation in this runtime, and the report lists every not-assessed K step. | Under the strict reading every case is `OUT_OF_SCOPE`, so the profile is empty. |
| R2 | A later `start` of the same authority re-submits the authority's single signed request, so the runtime's replay guard (request-level single use) answers it | Accept, with the caveat in the report that this shows request-level single use, not capability-level single use | `issued-permit` and `permit-single-use` become `OUT_OF_SCOPE` (13 in profile). |
| R3 | `sibling-isolation` is `IN_PROFILE`, because its revocation target has no descendants; it shows isolation of independent capabilities | Accept, with the caveat | It becomes `OUT_OF_SCOPE` (14 in profile). |
| R4 | `cancel_ack` after a runtime terminal, or without a cancellation request, is a declared unsupported class; the contract keeps ALLOW | Accept, and document the runtime's `false` with a conformance test | The contract would need to change `cancel_ack` semantics, which affects every runtime. |
| R5 | `OUT_OF_SCOPE` cases are not executed in 0.4.0; no diagnostic partial runs | Accept for 0.4.0, and revisit if partial-run diagnostics are wanted. Retained findings from partial runs would then need their own report section. | — |
| R6 | Exit code 3 for an accepted declared profile with incomplete coverage; exit 0 only for 27/27 | Accept | A partial profile could pass a 0.3.0-style CI gate. |
