# Runtime adapter compatibility — revocation track, `acs-guardrail-demo` @ `a682e44`, revised for `a9deab6` (v0.5.0)

Status: **approved specification (revision 3, `mikko-lab/agent-control-evals#12` head `3c1523a`), implemented by the integration (§12)**. This document defines how the pinned runtime adapter is evaluated against the revocation contract and the `revocation-0.4.0` contract changes the adapter needs. The integration work order made three clarifications binding; they override any conflicting wording and are applied in the text below and listed in §12.

**Revision 4 (v0.5.0 pin, coverage expansion package 1)** moves the pin to `a9deab6` in tenancy mode and adds tenant scope and ancestor revocation (§13). Sections 1–12 keep describing the `a682e44` pin, whose recorded observations are still re-evaluated unchanged; §13 states what differs for the new pin.

Revision 3 makes two changes after review of revision 2:
- **Ordering within a step (§4.6).** Runtime-adapter observations carry a probe-bound sequence index (`seq`). An effect can therefore be ordered after another effect of the same step when the adapter actually observed that order. With `seq`, the M11 trace in S4 (a start, then a premature terminal, both in step 0) is a causally ordered `unexpected_execution_terminal`, so the case is a VIOLATION and not `causally_impossible`. Observations without `seq` keep the unchanged 0.3.0 step-only semantics.
- **Verdict precedence for partial runs (§2.1, §2.5, §4.3, §9).** The verdict precedence is the evaluator's actual one: `HARNESS_ERROR → VIOLATION → UNASSESSABLE → PASS`. A confirmed finding plus an incomplete window is a VIOLATION that keeps its `incomplete` list. A harness error makes it a HARNESS_ERROR that keeps its findings. The exit codes are aligned with this.

Revision 2 made five changes after review of revision 1:
- **Full acceptance (§2.4–2.5).** It now requires every requirement of every case to be assessed, including `finish`/`seal` decisions. A declared profile never reaches exit 0.
- **No replay construction.** Every start uses a fresh signed request id under the authority's original capability, and `clearSession()` is never used. As a result `permit-single-use` is `OUT_OF_SCOPE`, and the gap between the `issued_permit` family name and what is actually tested is reported (§3.2, §5).
- **One runtime session per `(tenant, session)` pair.** Authorities in the same pair share that session and keep distinct capability ids (§3.1).
- **Effect observations do not depend on API responses.** Partial runs keep confirmed findings (§3.6, §4.1, §4.3).
- **Supplement of runtime-specific cases (§6).** It covers approval revocation, the terminal commit fence on its own, and an unobservable settlement. Its results are reported apart from corpus coverage and the profile pass rate.

| | |
|---|---|
| Contract today | `revocation-0.3.0` (`docs/revocation/evaluation-spec.md`), corpus of 27 cases, golden `corpus/revocation/smoke.sha256` |
| Runtime target | `mikko-lab/acs-guardrail-demo` commit `a682e4479dbccd1cd5f665f5d4879bd3dddb8b47` (merge of `mikko-lab/acs-guardrail-demo#10` into `b48f482`), tree `1346e92e64aff16183df84ea126271644498190a`, `package.json` version `0.4.0` |
| Runtime capabilities used | A1 authority revocation (`GuardedExecutor.revoke`, `RevocationReceiptV1`, request/approval/start/delivery fences) and A2 cooperative containment (`ExecutionContext`, `ctx.commit`, `ctx.track`, `acknowledgeCancellation`, `getExecution`, `terminals`, `whenTerminal`, `managedState`) |
| Unchanged | `sut.lock.json` (ACS track, `403d315`), `reports/v0.1/`, the ACS adapter and its accepted baseline, the synthetic revocation self-test, the 27-case corpus |

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
  "supplement": "profiles/revocation/acs-guardrail-demo-a682e44.supplement.json",
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
7. **Load the SUT.** Only these exports are loaded: `GuardedExecutor`, `AuthorityRevokedError`, `ReplayGuard`, `ReplayGuardError`, `CommitRejectedError`, `CancellationError`, the `tools` registry, and the signing, verification and audit classes needed to build signed requests and approval grants. The adapter never patches, re-exports or extends SUT modules.

### 1.3 Binding into the report and manifest

Every runtime-adapter report records a `sut` block with:
- `repository`, `commit`, `tree`, `version`;
- `lock_sha256`: the bytes of `sut.revocation.lock.json`;
- `build_sha256`: a hash over the loaded compiled modules;
- `baseline_verified`: true or false.

It also records `profile` and `supplement` blocks (`id`, `sha256`), the `harness_commit`, and `observation_source: "pinned_runtime_adapter"`. The manifest's implementation list additionally covers:
- the lock file;
- the profile and supplement files;
- the adapter modules;
- the compiled SUT module hashes.

A report whose `sut.commit` differs from the lock, or whose profile or supplement hash differs from the committed file, is refused by validation.

## 2. Capability profile and applicability

### 2.1 Two separate axes

**Applicability** is decided per case **before** any runtime is invoked or any observation is read. It is not a verdict.

| Applicability | Meaning |
|---|---|
| `IN_PROFILE` | Every SUT requirement of the case (§2.3) is expressible against the runtime, either directly or through a declared harness construction (§3). |
| `OUT_OF_SCOPE` | At least one SUT requirement of the case needs a capability the runtime does not offer. The case has **no verdict**, is never PASS, and is never executed against the SUT in 0.4.0. |

**Verdicts** apply only to `IN_PROFILE` cases (and to supplement cases, §6). They keep the `revocation-0.3.0` meaning:

| Verdict | Meaning |
|---|---|
| `PASS` | All assessed requirements were observed as the contract requires. |
| `VIOLATION` | Confirmed decision or effect findings. |
| `UNASSESSABLE` | The case is in the profile and has no confirmed finding and no error, but required evidence is missing: an UNKNOWN decision, a barrier timeout, an unsealed or drifting observation, an aborted adapter step, an effect order not established within a step (§4.6), or a missing terminal (including `unobservable`, §4.5). |
| `HARNESS_ERROR` | The harness or adapter broke the contract: schema violation, unattributable effect, causally impossible trace, a decision reported for a control step, an observation supplied for an `OUT_OF_SCOPE` case, a failed case setup, or a profile/lock binding mismatch. |

**Precedence (unchanged from the 0.3.0 evaluator):** `HARNESS_ERROR → VIOLATION → UNASSESSABLE → PASS`. The verdict is HARNESS_ERROR if the case has any error. Otherwise it is VIOLATION if it has any confirmed finding, otherwise UNASSESSABLE if it has any incompleteness, otherwise PASS. The verdict never discards the lower-ranked evidence:
- a VIOLATION case keeps its `incomplete` list;
- a HARNESS_ERROR case keeps its findings (`confirmed_violation: true`) and its `incomplete` list.

Incompleteness alone never hides a confirmed finding, and a confirmed finding never hides incompleteness.

`OUT_OF_SCOPE` is not `UNASSESSABLE`. The first means the runtime lacks the capability, as declared before the run. The second means a capability the runtime offers left no evidence in this run. A case never moves between the two because of what happened during the run.

### 2.2 How the profile is fixed

- **Versioned file.** The profile is a committed, versioned file (§7), bound to one lock (`sut_commit`) and one contract version.
- **Deterministic classifier.** Applicability is computed by a classifier that reads only the corpus, the oracle's expectations and the profile's capability rules, never observations or reports. The committed per-case list in the profile is golden-checked against that output. A disagreement fails the build.
- **Changes need a new profile.** Any change to the capability rules or the case list is a new profile version and requires review. It cannot be changed by a CLI flag or by an observation file.
- **Order of operations.** The CLI computes applicability, then all oracle expectations, before it invokes the adapter or reads observations, as `revocation-cli.ts` already does for the oracle.

### 2.3 What counts as a requirement

Every expected decision and every expected effect of a case is one requirement, and each is classified as:

- **D (direct):** the runtime itself makes the decision or produces the effect through its public API or state.
- **C (construction):** the runtime makes the decision or produces the effect, but *when* the triggering operation happens is set by a declared harness construction (§3.3).
- **O (out of scope):** the runtime has no corresponding capability. A single O requirement makes the whole case `OUT_OF_SCOPE`.
- **K (harness control):** the decision of a `finish` or `seal` step. In this profile these steps are harness commands, not SUT operations (§3.2), so the SUT cannot make a decision for them. K decisions are **not assessed**. They are listed per case in the report, and the adapter must not report them (§4.1).

K is a declared reduction of the profile, not a requirement the runtime passed. A K requirement is never counted as assessed, so **any run that skips a K decision cannot be a contract pass** (§2.4). A case that is partially implementable is `OUT_OF_SCOPE` as a whole. Its expressible requirements are listed but not evaluated, so they can never add up to a PASS.

### 2.4 Report content and acceptance flags

The report always lists **all 27 corpus cases**. Each entry carries:
- `applicability`;
- for `OUT_OF_SCOPE` cases, `out_of_scope` as a list of `{ step, requirement, capability_class, reason }`;
- `not_assessed_requirements`: the K steps;
- `tested_property`, plus a `family_caveat` where the family name describes a concept the runtime does not have (§5.1);
- the existing evidence fields, with `verdict: null` for `OUT_OF_SCOPE`.

Counts:

```
corpus_total                 27
in_profile                   N
out_of_scope                 27 - N
not_assessed_requirements    number of K requirements skipped across all executed cases
PASS / VIOLATION / UNASSESSABLE / HARNESS_ERROR   over in_profile only
corpus_coverage              N / 27
profile_pass_rate            PASS / N
```

Acceptance flags:

- `contract_acceptance_passed`: `out_of_scope == 0`, `not_assessed_requirements == 0`, every case has verdict `PASS`, and the run is technically valid. Every requirement of every case must have been assessed and passed. **In declared-profile mode it is always false**, because the profile itself declares K reductions. This holds even if a future profile classified all 27 cases `IN_PROFILE`.
- `profile_acceptance_passed`: `N > 0`, every `IN_PROFILE` case `PASS`, and technically valid.
- `has_confirmed_violation`: as in 0.3.0, including findings retained in incomplete or HARNESS_ERROR cases.

Supplement results (§6) are reported in their own section, with their own counts and `supplement_acceptance_passed`. They never enter `corpus_coverage`, `profile_pass_rate` or the acceptance flags above.

`summary.md` starts with a fixed statement in declared-profile mode:

> Declared-profile result for `<profile id>` on `<sut>@<commit>`: N of 27 corpus cases in profile, PASS P of N; R requirements (finish/seal decisions) not assessed. **This is not a revocation-0.4.0 contract pass.** Supplement: S of T runtime-specific checks as expected (reported separately; not part of corpus coverage).

### 2.5 Full-contract mode vs declared-profile mode

| | Full-contract mode (default) | Declared-profile mode (`run-adapter`, or `evaluate --profile FILE --lock FILE`) |
|---|---|---|
| Who uses it | Synthetic self-test and any adapter claiming the whole contract | A runtime adapter with an explicitly selected, committed profile |
| Cases requiring observations | All 27 | Exactly the `IN_PROFILE` cases, plus the supplement cases. An observation for an `OUT_OF_SCOPE` case is an input error. |
| Control-step decisions | Required and assessed (as in 0.3.0) | Must be absent. If present, the case is a HARNESS_ERROR (`decision_at_control_step`). |
| Can reach exit 0 | Yes, if every requirement of all 27 cases is assessed and passes | **Never** |

**`evaluate` / `run-adapter` exit codes (0.4.0)**, applied in the order listed:

| Exit | Condition |
|---|---|
| 2 | **Not technically valid.** Any of the following:<br>• an input, usage, lock or profile binding error;<br>• any corpus case with a non-empty `errors` list (verdict HARNESS_ERROR);<br>• any corpus case with a non-empty `incomplete` list, **whatever its verdict**, including a VIOLATION case that kept an incomplete window;<br>• any supplement case with an error, or with incompleteness outside its declared expected incompleteness (§6). The exemption covers only the incompleteness predeclared and versioned in the supplement file (`declared_incomplete`, golden-hashed); any other incompleteness or any error, in S4 too, leads to exit 2.<br>Exit 2 is returned also when confirmed violations were retained; `has_confirmed_violation` in the report says whether they were. |
| 1 | Technically valid (none of the exit-2 conditions) and at least one confirmed finding in the corpus or in the supplement |
| 3 | Declared-profile mode: technically valid, no confirmed finding, every `IN_PROFILE` case PASS, and every supplement case exactly as declared. **Not a contract pass.** |
| 0 | `contract_acceptance_passed` (full-contract mode only) |

"Technically valid" is the 0.3.0 notion: no case has errors or incompleteness. For the supplement it is relaxed in exactly one way. A supplement case's **declared** expected incompleteness (S4's missing terminal) does not count against validity, but any incompleteness beyond the declaration does. An exit code never depends on the verdict alone. A VIOLATION with an incomplete window is exit 2 with `has_confirmed_violation: true`, not exit 1.

Exit 0 means the whole contract was assessed and passed, so a CI gate written for 0.3.0 cannot mistake a declared profile for a contract pass. `self-test` keeps its 0.3.0 semantics (full-contract mode).

## 3. Command and effect correspondence

### 3.1 Identity mapping (fixed per case, before the run)

| Contract identity | Runtime identity | Class |
|---|---|---|
| Tenant/session pair `(t, s)` | Exactly **one** runtime `session_id` per pair, unique within the case. All authorities of the pair share that session. | C (the runtime has no tenant. Tenants are only a namespace for session ids.) |
| Authority `x` (initial `issued`) | One signed capability grant with its own `capability_id`, bound to the runtime session of `x`'s pair and to one tool, valid for the whole case under a fixed clock. Authorities in the same pair have **distinct** `capability_id`s in the **same** session. | C |
| Authority with initial `pending` | none in the corpus (the supplement uses a pending approval of its own, §6) | O |
| Authority `parent` link | none (no derived authority in the runtime) | O when a revocation's coverage depends on it (§3.4) |
| Each `start` attempt of `x` | A **fresh** signed tool-call request with a new `request_id`, under `x`'s original capability grant. The capability provider resolves every request id of `x` to the identical grant object. `clearSession()` is never called, and no request is ever re-submitted. | D |
| Execution label `e` | The runtime `execution_id` (`exec-<n>`) delivered to the tool double as `ctx.execution_id` when the runtime starts the execution. The adapter records `label → execution_id` only from this runtime-issued value. | D (runtime-assigned) |
| A label never started by the runtime | No runtime identity | Operations on it other than `finish` are O |

**Why one session per pair.** Session-scope revocation and session isolation are meaningful only if authorities of one contract session really share one runtime session. Then a session cut must reach all of them (`active-session`), and a capability cut must reach only one capability within a shared session (`sibling-isolation`, mutant M7). Giving every authority its own session would turn both into tests of something else.

**Authority–capability binding.** The runtime binds a managed execution to the `capability_id` it was authorised under, and binds each `capability_id` to the content of the first grant seen with it (A1 `capability_id_conflict`). The adapter:
- gives every authority a distinct `capability_id`;
- resolves every one of its requests to the same grant;
- uses a fixed clock and grant lifetimes that cover the whole case, so expiry can never masquerade as revocation.

On every observation of an execution (start, each later step, terminal), the adapter records the runtime snapshot's `capability_id` and `session_id`. Effects are attributed from the **runtime's** binding (`capability_id → authority`), never from the authority the harness intended. A binding naming no known capability is an unattributable effect (HARNESS_ERROR for that item; the other items are still evaluated). A binding naming another known authority is reported under that authority and judged by the evaluator. A change of binding between observations of one execution is reported as a diagnostic, and every effect is attributed to the binding observed at its own occurrence.

### 3.2 Commands

| Contract command | Runtime operation | Decision source | Class |
|---|---|---|---|
| `revoke` authority-scope target `x` | `executor.revoke({ scope: "capability", capability_id: cap(x) })` | Receipt returned → ALLOW; `RevocationTargetError` or another throw → DENY | D, when `x` has no descendants in the case (§3.4); otherwise O |
| `revoke` session-scope `(t, s)` | `executor.revoke({ scope: "session", session_id: sid(t, s) })` | as above | D |
| `revoke` tenant-scope | none (the runtime rejects tenant scope) | none | O |
| `approve` | none as a separate operation. The runtime's approval (`resolveApproval`) also starts the execution, in the same call. | none | O |
| `issue` | none. Permits are minted inside the runtime's start path (`ExecutionGate.mintPermit`) and are not observable or invocable separately. **The adapter must not mint, simulate or report a permit itself.** | none | O |
| `start x/e` | `executor.process(R)` with a fresh signed request `R` under `x`'s capability, for a tool that needs no approval | ALLOW: the runtime invoked the tool double. DENY: `process()` rejected with `AuthorityRevokedError` before the double was invoked. Any other outcome (`status: "pending"`, another error type, a watchdog timeout) → UNKNOWN, with the runtime error class and message recorded as a diagnostic. | D |
| A start that the contract denies **only** because the authority's permit was consumed (`permit_consumed` without `revoked`) | none. A capability in this runtime is reusable for any number of requests, and the runtime has no per-authority single-use permit. | none | O (`single_use_permit`) |
| `start y/e` with a label already in use by `x` | none (the runtime assigns execution ids itself) | none | O |
| `commit x/e` (label started by the runtime) | The harness calls the retained `ctx.commit(key(e, n), value)` synchronously at the step, where `n` is the commit attempt number | `CommitReceipt` → ALLOW; `CommitRejectedError` → DENY (the runtime reason is recorded as a diagnostic); any other throw → UNKNOWN (diagnostic) | D. Calling the retained context after the tool function has settled is C (detached-work pattern, as in the runtime's C13). |
| `commit` on a label the runtime never started | none (there is no context) | none | O |
| `deliver x/e` before `finish x/e` | The harness fulfils the tool double's returned Promise with the per-execution output nonce `out(e)`. That makes the runtime process the result and reach its delivery fence. | Public promise of `process()` fulfils with `exit_status: "success"` carrying `out(e)` → ALLOW. Fulfils with `exit_status: "blocked"` and code `session_revoked` or `capability_revoked` → DENY. Anything else → UNKNOWN. | C (trigger), D (decision) |
| `deliver x/e` after `finish x/e` | none. The tool function has already settled at `finish`, and the runtime has no later delivery operation. | none | O |
| `cancel_ack x/e` | The harness calls the retained `ctx.acknowledgeCancellation()` at the step | `true` → ALLOW; `false` → DENY, with the snapshot (`cancellation_requested`, `cancellation_acknowledged`, `state`) recorded as a diagnostic | D within the construction; see §3.5 |
| `finish x/e` | Harness control: release the execution's registered-work lock, and if the tool function's Promise is still pending, settle it (reject with the harness error `HarnessFinish`, or resolve it for the supplement's unobservable variant, §6) | none. **K: no SUT decision is reported.** | K (decision), C (timing of the terminal) |
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

The contract's authority-scope revocation covers the target and all its descendants. The runtime's capability-scope revocation covers exactly one `capability_id`. An authority-scope revoke is therefore D only when its target has **no descendants** in the case's predeclared authority tree (checked by the classifier). Otherwise it is O. Parent links that no revocation depends on (for example the parent of a revoked leaf in `sibling-isolation`) are not modelled. Such a case then shows isolation between independent capabilities in one shared runtime session, not tree semantics (R3).

### 3.5 Specifics requested for review

- **`issue`:** O for this runtime. The adapter never mints or reports a permit, and never presents a harness action as a runtime decision. Initial `issued` authorities are expressed only as a valid capability grant. The runtime has no permit object, no `approved`-but-not-`issued` state, and no consumed state.
- **Single use:** no construction substitutes for it. Each start is a fresh request under the original capability, so the runtime answers it as it would any new request. A case whose required denial rests on `permit_consumed` alone is `OUT_OF_SCOPE`.
- **`finish`:** releasing the lock is a harness command with no SUT decision (K). The terminal is a separately observed runtime state: `getExecution().state === "terminal"`, an entry in `terminals()`. It is never inferred from the lock release.
- **`deliver`:** the fulfilment of the public Promise and the execution terminal are independent runtime events, and their order is not fixed. With the construction, a `deliver` before `finish` fulfils the public Promise while the execution is still `draining`, and the terminal follows at `finish`. When `finish` comes without `deliver`, both events happen in the `finish` step, in either order. The tool double's rejection means the public Promise carries no output nonce, so no `output_delivery` is observed. The adapter binds each event to the step whose barrier it appeared in (§4.2), never to its order relative to the other.
- **`cancel_ack`:** within the construction, every `cancel_ack` in an `IN_PROFILE` case reaches an execution that is running or draining, after a covering revocation, and before `finish`. There the runtime's `acknowledgeCancellation()` returns `true` exactly when the contract expects ALLOW. **A direct correspondence is not established in general:**
  - The runtime returns `false` for an execution that is already terminal. The contract still expects ALLOW for a bound execution whose finish has not been requested, for example one that ended at its revocation.
  - The runtime returns `false` when no cancellation was requested. The contract does not require a prior revocation.

  Neither situation is reachable in the construction or in the corpus. Both are declared in the profile as unsupported capability classes, `cancel_ack_after_runtime_terminal` and `cancel_ack_without_cancellation_request`. Integration adds one adapter conformance test that pins the runtime's `false` for an already-terminal execution, so the divergence is documented rather than assumed (R4).
- **Authority–capability binding:** see §3.1. Each authority keeps one original grant for the whole case. Every request of the authority resolves to that grant, and every observed effect is attributed from the runtime's own binding at its occurrence.

### 3.6 Effects

Effects are observed from SUT state and independent harness observation. They are **never** derived from, or suppressed by, the API response of the same step. When an API response and an observed effect disagree, both are reported: the decision from the response and the effect from the observation. The evaluator judges them separately (for example, a DENY together with an observed commit is an effect violation). A disagreement is recorded as a diagnostic and is **not** by itself a HARNESS_ERROR.

| Contract effect | Observation | Source | Class |
|---|---|---|---|
| `revocation_ack` (target) | The receipt returned by `revoke()`, `status` `revoked` or `already_revoked`. Its `target` is mapped back (`capability_id → authority`, `session_id → (t, s)`). A receipt target that maps back to a different contract target is reported as such. | `sut_api` | D |
| `approval_granted`, `permit_issued` | none | none | O |
| `execution_started` | The tool double was invoked with a fresh context (`harness_observation`), whatever `process()` later returned. Attribution comes from the runtime record `getExecution(ctx.execution_id)` (`sut_state`). If that record is absent, attribution comes from the request marker passed through the tool arguments, with a diagnostic. | `harness_observation` + `sut_state` | D |
| `tool_commit` | A change of `managedState` (version increment, `get(key(e, n))` holds the value), observed in the step's barrier (`sut_state`). It is reported whether the call returned a receipt, threw `CommitRejectedError`, or threw anything else. Attribution comes from the runtime binding of the context whose call was in progress. A state change during a step with no harness commit call is attributed by its key and flagged as a diagnostic. | `sut_state` | D |
| `output_delivery` | Public `process()` promise fulfilled with `exit_status: "success"` and `out(e)` | `sut_api` | C (trigger), D (effect) |
| `cancellation_ack` | The snapshot's `cancellation_acknowledged` flipped from false to true within the step (`sut_state`). The method's return value is the decision, not the effect. | `sut_state` | D |
| `execution_terminal` | `getExecution(id).state === "terminal"` with the snapshot's own terminal record for the same execution, and exactly one entry for it in `terminals()`; all three are recorded in every probe, and any other combination is contradictory evidence (incomplete, §12). The occurrence step is the step in whose barrier the state first appeared. `whenTerminal()` is used only as a bounded wake-up, never as the evidence itself. | `sut_state` | D (state), C (timing) |

The audit stream is the runtime's own report. It is kept in the bundle as diagnostics and is **not** evidence for any decision or effect, matching the runtime's own A2 test discipline.

## 4. Evidence and timing

### 4.1 Provenance and no back-filling

- **Expectations** come only from the oracle (`expected(c)`), computed before the adapter runs. The supplement's declared expectations are covered in §6.
- **Observed decisions and effects** come only from the SUT's API return values or exceptions (`sut_api`), the SUT's inspectable state (`sut_state`), or independent harness observation of the tool doubles and public Promises (`harness_observation`). Each observed item carries its provenance.
- **No back-filling.** The adapter never derives a decision or effect from the oracle, the corpus design or the supplement expectations. It never fills a missing observation, and never reports a decision for a K step. Anything it cannot observe is UNKNOWN or absent and becomes incomplete evidence.
- **Decisions and effects are independent.** A missing or contradictory API response never removes an observed effect, and an observed effect never changes a reported decision (§3.6).
- **Runtime reasons are diagnostics only.** Examples are `AuthorityRevokedError.stage` and `.reason`, `CommitRejectedError.reason`, and the withheld `code`. They are recorded as `sut_reason` diagnostics and never feed the verdict. The contract compares decisions, not reasons, so overdetermined oracle denials (for example `revoked + already_committed`) are matched by any runtime DENY.

### 4.2 Step binding and explicit barriers

Steps run strictly in order. Each step has an action and an explicit completion barrier. An effect is bound to step *i* if it first appears between the start of step *i*'s action and the completion of step *i*'s barrier.

| Op | Barrier (step complete when) |
|---|---|
| `revoke`, `commit`, `cancel_ack` | The synchronous call has returned or thrown. Cancellation listeners run synchronously inside `revoke()`. |
| `start` | The double's entry latch has fired, **or** the public `process()` Promise has settled (whichever event comes first). For a declared double variant that does not hold the tool function's Promise for a later step (`returns_unobservable_pending_promise`, S4), the barrier also requires the public Promise to have settled, because the runtime fails such a call within the step. |
| `approve` (supplement only) | Same rule as `start`, applied to the `resolveApproval()` Promise |
| `deliver` | The public Promise has settled |
| `finish` | The execution's terminal is present in `getExecution()`, **or** the execution is in the runtime's own stable state `unobservable` (in which the runtime never records a terminal, §4.5). In either case the public Promise must also have settled if it was still pending. |
| `seal` | One macrotask turn (`setImmediate`) has completed after the last step, followed by the drift check |

**Drift check.** The adapter snapshots the observable state when each barrier completes:
- `managedState` version and keys;
- every execution snapshot;
- `terminals()`;
- the public Promise states;
- the tool doubles' logs.

It snapshots again immediately before the next action, and once more at `seal`. A difference means an effect occurred outside any step's barrier. Its occurrence step cannot be established, so the observation is reported as `complete: false` (incomplete evidence), and the drifted item is kept as a diagnostic. A fixed number of microtask turns is never used as a barrier.

**Watchdog.** Each asynchronous barrier has a fixed wall-clock bound, proposed as 2000 ms and declared in the profile. When it expires, the step's decision is UNKNOWN and the observation is `complete: false`. A timeout only adds incompleteness. It never produces ALLOW, DENY or an effect, so it can neither create a finding nor turn a case into PASS. Findings already confirmed before the timeout are kept (§4.3).

### 4.3 Seal, completeness and partial runs

`complete: true` only if every step's barrier completed, no drift was detected, and the seal quiescence check found no change.

**Partial runs keep their evidence.** If a barrier times out, a step's action throws in the adapter, or the adapter aborts a case for any reason:
- the adapter still emits every decision and effect already observed, with `complete: false`;
- it records the failing step and the error as diagnostics;
- any remaining steps are not run.

The evaluator then applies the unchanged precedence (§2.1):
- With a confirmed finding and no error, the case is **VIOLATION** and keeps its `incomplete` list.
- With an error, it is **HARNESS_ERROR** and keeps its findings and its `incomplete` list.
- Only without findings and errors is it UNASSESSABLE.

`confirmed_violation` and `has_confirmed_violation` stay true in every one of these cases. Because of the incompleteness the run is not technically valid, so it exits with code 2 (§2.5). An adapter failure never discards an observation.

After the observation is frozen, the adapter releases any remaining harness locks for cleanup. Effects of cleanup are not observed.

### 4.4 Fresh state per case

Each case gets:
- a new `GuardedExecutor` (with its own managed state store), fresh signing keys and a fresh replay guard;
- a fixed clock and a fresh capability provider;
- per-case tool doubles installed in the SUT's `tools` registry, restored afterwards; `executionCounters` reset.

The adapter's behaviour must not depend on a case's `id` or `family` (as in 0.3.0). It receives only `authorities`, `steps`, the identity mapping and, for supplement cases, the declared setup and tool-double variant (§6).

### 4.5 `unobservable` and `whenTerminal()`

A managed execution in state `unobservable` (`mikko-lab/acs-guardrail-demo#10`) is an applicable execution whose terminal evidence is missing. That is incompleteness (UNASSESSABLE when nothing else is found), never OUT_OF_SCOPE, and never a `failed` terminal. The adapter:
- does not await `whenTerminal()` without a bound;
- treats the runtime's `unobservable` state as the end of the `finish` barrier (§4.2), so the run is not prolonged into a watchdog timeout;
- records `state: "unobservable"` as a diagnostic;
- reports no `execution_terminal`.

The corpus construction's Promises are always observable, so this state is reached only in supplement case S4 (§6) or through a SUT defect or mutant.

### 4.6 Ordering within a step (`seq`)

The 0.3.0 evaluator orders effects by occurrence step only. It requires an execution's start at a strictly earlier step than any commit, delivery, cancellation acknowledgement or terminal of that execution, a commit at an earlier step than a delivery, and a terminal at an earlier step than a "commit/delivery after terminal" finding. A runtime can legitimately produce two related effects within one contract step. The case that matters is S4 under M11: the runtime starts the tool and then records a premature `failed` terminal before the step's barrier completes. The current evaluator rejects that trace as `causally_impossible` (HARNESS_ERROR), although the adapter observed a causally ordered and forbidden behaviour.

**Probes.** The adapter takes **probes**: synchronous snapshots of the full observable state (§4.2 drift-check contents), each with a strictly increasing probe index within the case. Probes are taken at fixed points:
- immediately before each step's action;
- **synchronously inside the tool double's entry function**, before it returns to the runtime;
- synchronously inside every harness callback that ends a barrier wait (public Promise settled, terminal wake-up);
- at barrier completion;
- immediately before the next action (the drift check);
- at seal.

The probe log is part of the observation bundle. Each entry records its index, step, probe point and the raw observable state (`ProbeState`: revocation receipts, tool-double invocations with their request marker, runtime execution records with their capability and session binding and their own terminal record, the executor's terminal log, managed-state keys with the value `get(key)` returned, the managed-state version, deliveries). The effect identities present in a probe are derived from that state by one shared function (`src/spec/revocation/runtime-observation.ts`), which the adapter uses to report and the evaluator uses to check the report.

**`seq`.** Every effect in a `pinned_runtime_adapter` observation carries `seq`: the index of the **first probe at which the effect was present**. Because every probe records the whole observable state, the effect was absent from every earlier probe. Therefore `seq(E1) < seq(E2)` proves that `E1` had occurred and `E2` had not yet occurred at probe `seq(E1)`: `E1` is before `E2`. Equal `seq` proves no order.

Examples:
- **Tool start.** A tool start is observed by the probe inside the double's entry function. That probe also records the execution's state at that instant (`running`, no terminal).
- **S4 under M11.** The premature terminal appears only at a later probe of step 0 (the public-Promise callback or barrier completion). So `seq(execution_started) < seq(execution_terminal)` holds within step 0, as the adapter actually observed it.

**What `seq` is not.** It is never taken from the oracle, the corpus, the order of the `effects` array, or any sorting of effects after the run. An adapter may not renumber effects. `seq` must be the probe index recorded when the effect was first observed.

**Validation (HARNESS_ERROR `sequence_inconsistent` when violated):**
- `seq` values are non-negative integers, and every effect has one (mixing effects with and without `seq` is a schema violation);
- an effect with a higher step never has a lower or equal `seq` than an effect with a lower step;
- every `seq` refers to a probe in the probe log whose step equals the effect's step;
- the effect is present in that probe and absent in the probe before it.

**Evaluator rule with `seq` (0.4.0, `pinned_runtime_adapter` only).** Every "earlier/later" comparison of the causal and after-terminal checks uses the lexicographic order `(step, seq)` instead of `step` alone:

| Check | 0.3.0 (no `seq`) | 0.4.0 with `seq` |
|---|---|---|
| Execution effect needs a start of its execution | start at a strictly earlier step | start strictly earlier in `(step, seq)` |
| Delivery needs a commit | commit at a strictly earlier step | commit strictly earlier in `(step, seq)` |
| Commit/delivery after the observed terminal | terminal at a strictly earlier step | terminal strictly earlier in `(step, seq)` |
| Every observed start needs a later terminal | terminal at a strictly later step | terminal strictly later in `(step, seq)` |

- **Equal `(step, seq)`.** When two related effects have the same step and the same `seq`, their order is **not established**. This is not proof of impossibility. The ambiguity blocks **only that order inference**: the case records the incompleteness `effect order not established at step i: <kind> of <execution> relative to <its start | its commit | its terminal>`, and the inference concerned (causal impossibility, "after terminal", start/terminal pairing) is neither drawn nor turned into an error. The effect itself still takes part in the step-based evaluation, so a violation established by the step boundary alone (for example a terminal outside its window) is still a confirmed finding, and every other confirmed finding stays. A coarse probe can therefore never create a HARNESS_ERROR, never hide a step-based finding, and never produce a PASS.
- **Strictly later in `(step, seq)`.** A dependent effect observed strictly *before* every start in `(step, seq)` order remains `causally_impossible`.
- **Windows are unchanged.** Expected-effect windows stay in steps, and `withinWindow` is unchanged. `seq` orders effects; it never moves an effect into or out of a window.

**0.3.0 path unchanged.** Observations without `seq` (`synthetic_harness_trace`, `external_adapter_declared_unverified`) are evaluated exactly as in 0.3.0: step-only ordering, same messages, same verdicts. Byte-identical self-test and regression outputs prove this, apart from the version string (§9).

**S4 under M11 with `seq`.** The trace is start (step 0, seq p) and terminal (step 0, seq q > p):
- Both are accepted: the terminal is causally after the start.
- The terminal lies outside its window `[1..2]`, so the evaluator reports `unexpected_execution_terminal`@0.
- The in-window terminal stays unconfirmed: incomplete `terminal evidence missing for e1 in window 1..2`.
- The start has a later terminal, so `execution not observed terminal` is **not** reported.

The verdict is VIOLATION, with `confirmed_violation: true` and that one incomplete entry.

## 5. Case matrix (27 cases)

Step numbers refer to the committed corpus. Abbreviations:
- **ack** = `revocation_ack`;
- **D / C / O / K** as defined in §2.3;
- **K-steps** are the `finish` and `seal` decisions that are not assessed. `seal` is the last step of every case and is always K.

**Summary:** 14 `IN_PROFILE`, 13 `OUT_OF_SCOPE`. Corpus coverage is 14/27.

| # | Case | Family | Applicability | D requirements | C requirements | O requirements (reason) | K-steps (besides seal) |
|---|---|---|---|---|---|---|---|
| 1 | `pending-approval` | pending_approval | OUT_OF_SCOPE | ack@0 | — | initial `pending`; `approve`@1, `issue`@2 (no separate approval/permit operation) | finish@4 |
| 2 | `issue-after-cut` | pending_approval | OUT_OF_SCOPE | ack@1 | — | `approve`@0, `issue`@2 | finish@4 |
| 3 | `issued-permit` | issued_permit | IN_PROFILE (caveat) | ack@0; start DENY@1; start DENY@2 (fresh request id, same capability; denied by revocation) | — | — | finish@3, finish@4 (DENY unbound not assessed) |
| 4 | `fresh-id-retry-unused-permit` | issued_permit | OUT_OF_SCOPE | ack@3 | — | initial `pending`; start DENY `permit_not_issued`@0 (no not-yet-issued state); `approve`@1, `issue`@2 | finish@5, finish@6 |
| 5 | `cut-before-start` | issued_permit | IN_PROFILE (caveat) | ack@0; start DENY@1 | — | — | finish@2 |
| 6 | `duplicate-revocation` | issued_permit | IN_PROFILE (caveat) | ack@0; ack@1 (`already_revoked`); start DENY@2 | — | — | finish@3 |
| 7 | `active-session` | active_session | IN_PROFILE | session ack@0; start a DENY@1; start b DENY@2 (a and b share one runtime session, distinct capabilities) | — | — | finish@3, finish@4 |
| 8 | `session-in-flight-commit-fence` | active_session | IN_PROFILE | start a@0, start o@1 (+started); session ack@2; commit a DENY@3; commit o ALLOW@4 (+commit) | deliver o ALLOW@5 (+delivery); terminal a ∈[2..8] at finish@6; terminal o at finish@7 | — | finish@6, finish@7 |
| 9 | `session-delivery-fence-after-commit` | active_session | IN_PROFILE | start@0; commit@1; session ack@2 | deliver DENY@3 (withheld); terminal at finish@4 | — | finish@4 |
| 10 | `tenant-multi-session-in-flight` | active_session | OUT_OF_SCOPE | starts@0–2; commit c@6 | deliver c@7 | tenant-scope revoke@3 and its fences@4–5 | finish@8–10 |
| 11 | `start-before-cut` | in_flight_before_commit | IN_PROFILE | start@0; ack@1; commit DENY@2 | terminal at finish@3 (tool Promise rejected by harness, no output) | — | finish@3 |
| 12 | `in-flight-before-commit` | in_flight_before_commit | IN_PROFILE | start@0; ack@1; cancel_ack ALLOW@2 (+cancellation_ack); commit DENY@3 | deliver DENY@4 (withheld; oracle reasons `revoked+not_committed`, runtime explains by revocation); terminal at finish@5 | — | finish@5 |
| 13 | `late-commit-after-terminal` | in_flight_before_commit | OUT_OF_SCOPE | start@0; ack@1 | commit DENY@3 (retained context after terminal) | `deliver`@4 after `finish` (no runtime delivery operation after the tool function settled) | finish@2 |
| 14 | `retry-after-revocation` | in_flight_before_commit | OUT_OF_SCOPE | start@0; ack@1; start DENY@3 (fresh request; revoked) | — | `commit a/retry`@4 on an execution the runtime never started | finish@2, finish@5 |
| 15 | `in-flight-after-commit` | in_flight_after_commit | IN_PROFILE | start@0; commit@1; ack@2; cancel_ack@3; commit DENY@5 (oracle `revoked+already_committed`; the runtime has no once-only commit rule, so revocation explains it) | deliver DENY@4 (withheld); terminal at finish@6 | — | finish@6 |
| 16 | `commit-before-cut` | in_flight_after_commit | IN_PROFILE | start@0; commit@1; ack@3 (cancellation requested while draining) | deliver ALLOW@2 (+delivery, execution stays draining); terminal ∈[3..5] at finish@4 | — | finish@4 |
| 17 | `commit-shift-across-cut` | in_flight_after_commit | IN_PROFILE | start@0; commit@1; ack@2; cancel_ack@3 | terminal at finish@4 | — | finish@4 |
| 18 | `cancel-is-not-rollback` | in_flight_after_commit | OUT_OF_SCOPE | start@0; commit@1; ack@2; cancel_ack@3 | — | `deliver`@5 after `finish` | finish@4 |
| 19 | `derived-authority` | descendant_scope | OUT_OF_SCOPE | — | — | revoke of `a` must cover descendants `child`, `pending-child`; `approve`@2, `issue`@3 | finish@4 |
| 20 | `derived-in-flight-ancestor-revoked` | descendant_scope | OUT_OF_SCOPE | start child@0 | — | revoke of `a`@1 must fence `child`'s commit@2 (descendant coverage) | finish@3 |
| 21 | `sibling-isolation` | scope_isolation | IN_PROFILE (R3) | ack@0 (target `child` has no descendants); start child DENY@1; start sibling@2; commit sibling@3; start a@7 (all three in one runtime session) | deliver sibling@4; terminal sibling at finish@5; terminal a at finish@8 (no output) | — (parent links not modelled) | finish@5, finish@6, finish@8 |
| 22 | `session-isolation` | scope_isolation | IN_PROFILE | session ack@0; start a DENY@1; start other@2; commit other@3 | deliver other@4; terminal other at finish@5 | — | finish@5, finish@6 |
| 23 | `tenant-isolation` | scope_isolation | OUT_OF_SCOPE | starts/commit of `other`@2–3 | deliver other@4 | tenant-scope revoke@0 and its fence@1 | finish@5, finish@6 |
| 24 | `execution-id-reuse` | identity | OUT_OF_SCOPE | start a@0; commit a@4 | — | `start b/e1`@1 (client-chosen execution id); `commit b/e1`@2 on an execution the runtime never started | finish@3, finish@5 |
| 25 | `permit-single-use` | control | OUT_OF_SCOPE | start@0; commit@2 | deliver@3 | start DENY `permit_consumed`@1 without revocation: a fresh request under the same capability is admitted by this runtime, which has no single-use permit (`single_use_permit`) | finish@4, finish@5 |
| 26 | `approval-before-cut` | control | OUT_OF_SCOPE | ack@6 | — | initial `pending`; `approve`@0, `issue`@1 | finish@5 |
| 27 | `deferred-terminal-before-seal` | observation_timing | IN_PROFILE | start@0; ack@1; cancel_ack@2 | terminal ∈[1..5] at finish@3; commit DENY@4 (retained context; runtime reason `execution_terminal`, oracle `revoked+finish_requested`) | — | finish@3 |

Requirements listed in the D and C columns of an `OUT_OF_SCOPE` row are informational only. They are not run and not evaluated in 0.4.0 (R5).

### 5.1 Family names vs tested properties

`family` is the scenario's design intent in the contract. For this runtime some family names describe concepts the runtime does not have. Each `IN_PROFILE` case therefore carries a `tested_property` in the profile, and a `family_caveat` where the two differ. Both appear in the report next to the family.

| Case | Family | Tested property on this runtime | Family caveat |
|---|---|---|---|
| `issued-permit` | issued_permit | A revoked capability denies two fresh requests under it before any execution | The runtime has no permit object. Neither "unused permit" nor "fresh-ID retry on an unused permit" is tested; both denials are explained by revocation of the capability. |
| `cut-before-start` | issued_permit | A capability revoked before its first request is denied at the start | No permit; as above |
| `duplicate-revocation` | issued_permit | A repeated capability revocation is acknowledged (`already_revoked`) and still denies a request | No permit; as above |
| `sibling-isolation` | scope_isolation | A capability cut leaves two other capabilities in the same runtime session usable | Parent/child links are not modelled; no tree semantics (R3) |
| all other `IN_PROFILE` cases | — | As the family names it, restricted to capability and session scopes | — |

No case in the `issued_permit` family tests a permit property on this runtime. The report shows the `issued_permit` family as covered only in the sense of these tested properties.

### 5.2 Coverage of the design claims within the profile

- **Sole-revocation fences covered:** start (authority, session), commit (authority, session) and delivery (authority, session).
- **Not covered by the corpus profile:** approve, issue, the descendant and tenant fences, single use and the identity fences.
- **Added by the supplement (§6), reported separately:** the approval fence on a pending runtime approval, the terminal commit fence without revocation, and an unobservable settlement.

## 6. Runtime-specific supplement

The supplement is a small, separate set of cases for capabilities that this runtime does have, but that the 27-case corpus cannot express or only reaches in an overdetermined way. It does **not** change the corpus, its golden SHA or the contract oracle.

**File and binding.** It lives in `profiles/revocation/acs-guardrail-demo-a682e44.supplement.json`, is versioned and golden-hashed, and is bound to the same lock. Each case is written in the contract `Case` format, plus two declared fields:
- `setup`: an action the adapter performs before step 0 (for example, submit an approval-requiring request and require `status: "pending"`). A setup that does not produce its declared result is a HARNESS_ERROR (`setup_failed`).
- `double`: the tool-double variant. The default is the §3.3 construction; `returns_unobservable_pending_promise` is the S4 variant below.

**Expectations.** Where the contract model fits, the expected decisions and effects are those of the unchanged contract oracle, golden-checked in the supplement file. Where this runtime's semantics differ from the contract model by design, the supplement declares a **runtime-specific expectation**, marked as such and reviewed with the file. Either way, expectations are fixed before the run and never derived from observations.

**Expected verdicts.** Each supplement case declares the verdict expected at the pin, together with the exact expected findings, incompleteness and errors. `supplement_acceptance_passed` is true only when every supplement case matches its declaration exactly. The section is reported apart from `corpus_coverage`, `profile_pass_rate`, `profile_acceptance_passed` and `contract_acceptance_passed`.

| ID | Case | Authorities / setup / double | Steps | Expectation source | Expected at pin |
|---|---|---|---|---|---|
| S1 | `sup-pending-approval-revoked` | `a` initial `pending`, approval-requiring tool. Setup: `process(R_a)` must return `status: "pending"`. | 0 revoke `a` (capability); 1 approve `a` (`resolveApproval` with a valid signed grant for `R_a`; the label of the execution it would start is `e1`); 2 finish `a/e1`; 3 seal | Contract oracle: ack@0; approve DENY@1; no other effect | **PASS**: approve DENY (`AuthorityRevokedError`), tool double never invoked, no execution record, no terminal |
| S2 | `sup-pending-approval-control` | as S1 | 0 approve `a`; 1 finish `a/e1`; 2 seal | **Runtime-specific**: approve ALLOW with `execution_started a/e1`@0, because approval and start are one runtime operation; terminal ∈[1..2]. The contract would expect `approval_granted` instead. | **PASS**: non-vacuity control for S1, showing that the approval path with this setup starts the tool |
| S3 | `sup-commit-after-terminal-no-revocation` | `a` initial `issued`; default double | 0 start `a/e1`; 1 commit `a/e1` (key 1); 2 finish `a/e1`; 3 commit `a/e1` (key 2, retained context); 4 seal | Contract oracle: commit ALLOW@1; commit DENY@3 (oracle reasons `finish_requested+already_committed`; this runtime has no once-only rule, so its DENY is explained by the terminal alone); terminal ∈[2..4] | **PASS**: commit@1 changes the state (non-vacuity), commit@3 is denied with runtime reason `execution_terminal`, and the state is unchanged. No revocation masks the terminal fence. |
| S4 | `sup-unobservable-pending-settlement` | `a` initial `issued`; double `returns_unobservable_pending_promise`: the tool returns a pending native Promise with a non-configurable `constructor` accessor and registers no work | 0 start `a/e1`; 1 finish `a/e1` (harness resolves the hidden Promise); 2 seal | Contract oracle: start ALLOW + `execution_started`@0; terminal ∈[1..2] | **UNASSESSABLE**, exactly: incomplete = {`terminal evidence missing for e1 in window 1..2`, `execution not observed terminal: e1`}; no findings, no errors. These are the strings the current evaluator produces for this trace. The runtime fails the call, holds the execution in `unobservable`, and never records a terminal, including after the Promise settles at step 1. |

`approve` uses the same decision mapping as `start`: ALLOW when the runtime invoked the tool double; DENY when `resolveApproval()` rejected with `AuthorityRevokedError` before any invocation; UNKNOWN otherwise.

S4 is a control run whose correct outcome is missing terminal evidence. **A PASS for S4 would itself be a failure of the supplement**: it would mean a terminal was reported for an unobserved settlement.

Under mutant M11 the runtime records a `failed` terminal during step 0, after the tool start and before the terminal window opens at `finish`. The probe inside the double's entry function records the start with no terminal present, and the terminal first appears at a later probe of step 0. With `seq` (§4.6) the evaluator reports:
- `unexpected_execution_terminal`@0;
- verdict **VIOLATION**;
- `confirmed_violation: true`;
- incomplete = {`terminal evidence missing for e1 in window 1..2`}.

The incompleteness is within S4's declared expected incompleteness, so the run is technically valid. The confirmed finding gives exit 1 (§2.5), and the mismatch with the declared UNASSESSABLE fails `supplement_acceptance_passed`.

Without `seq`, the current 0.3.0 evaluator rejects this trace as `causally_impossible` (HARNESS_ERROR, exit 2). That is why §4.6 is required for M11's witness.

## 7. Proposed capability profile

The profile would be committed in the integration phase as `profiles/revocation/acs-guardrail-demo-a682e44.profile.json`, with a golden SHA-256. Sketch:

```json
{
  "profile": "acs-guardrail-demo-a682e44/revocation-0.4.0/2",
  "contract": "revocation-0.4.0",
  "corpus_sha256": "<current golden corpus/revocation/smoke.sha256>",
  "sut_lock": { "file": "sut.revocation.lock.json", "sut_commit": "a682e4479dbccd1cd5f665f5d4879bd3dddb8b47" },
  "control_ops": ["finish", "seal"],
  "identity": { "runtime_session": "one per (tenant, session) pair", "capability": "one per authority", "request": "fresh per start attempt", "clear_session": "never" },
  "supported": {
    "revoke": { "scopes": ["authority_without_descendants", "session"] },
    "start": { "each_attempt": "fresh signed request under the authority's original capability" },
    "commit": { "on": "execution started by the runtime", "after_terminal": "retained context" },
    "deliver": { "before_finish": true },
    "cancel_ack": { "after_covering_revocation_before_finish": true }
  },
  "unsupported_classes": [
    "initial_pending_authority", "approve", "issue", "single_use_permit",
    "tenant_scope_revocation", "descendant_coverage",
    "client_chosen_execution_id", "operation_on_execution_unknown_to_runtime",
    "deliver_after_finish",
    "cancel_ack_after_runtime_terminal", "cancel_ack_without_cancellation_request",
    "commit_once_only_sole_denial", "deliver_requires_commit_sole_denial"
  ],
  "barrier_watchdog_ms": 2000,
  "cases": [
    { "id": "issued-permit", "applicability": "IN_PROFILE", "not_assessed_requirements": [3, 4, 5],
      "tested_property": "a revoked capability denies two fresh requests under it",
      "family_caveat": "no permit object; neither unused-permit nor fresh-ID-retry semantics are tested" },
    { "id": "permit-single-use", "applicability": "OUT_OF_SCOPE", "out_of_scope": [
      { "step": 1, "requirement": "decision", "capability_class": "single_use_permit", "reason": "a fresh request under the same capability is admitted; the runtime has no single-use permit" }
    ] }
  ]
}
```

The `cases` list is truncated here. The full list has all 27 entries matching §5 and §5.1 and is golden-checked against the classifier. The last two unsupported classes are reached by no corpus case. They are declared so that a future case with a sole `already_committed` or `not_committed` denial is classified `OUT_OF_SCOPE` instead of producing a false VIOLATION.

## 8. Changes proposed for `revocation-0.4.0`

The corpus and its golden SHA are unchanged. Full-contract semantics are unchanged from 0.3.0, apart from the version string, the new flags and exit code 3.

| Area | Change |
|---|---|
| Model (`src/spec/revocation/model.ts`) | Add the `Applicability` type (`IN_PROFILE`, `OUT_OF_SCOPE`), `Profile` and `Supplement` types, `control_ops`, and the requirement classes `D`/`C`/`O`/`K` |
| Classifier (new) | A pure function `(corpus, oracle, profile rules) → applicability`, with a golden test against the committed profile. It never imports observation or report code (extends `check:oracle-boundary`). |
| Observation schema | `observation_source: "pinned_runtime_adapter"`. Per-item `provenance` (`sut_api` / `sut_state` / `harness_observation`), and per-effect `seq` with the probe log (§4.6), both required for that source and absent for the 0.3.0 sources. Optional `diagnostics` (`sut_reason`, API/state disagreements, drift items, aborted step, unobservable state) that never feed the verdict. Decisions at control steps must be absent in declared-profile mode. |
| Evaluator | `(step, seq)` ordering for the causal and after-terminal checks when `seq` is present; `sequence_inconsistent` validation; "effect order not established" incompleteness for equal `(step, seq)`; step-only 0.3.0 behaviour when `seq` is absent (§4.6). Profile-aware. Skips K decisions and counts them as `not_assessed_requirements`; a supplied K decision → HARNESS_ERROR `decision_at_control_step`. An observation for an `OUT_OF_SCOPE` case → input error. `OUT_OF_SCOPE` evidence entries carry `verdict: null`. Verdict precedence unchanged (`HARNESS_ERROR → VIOLATION → UNASSESSABLE → PASS`); findings and incompleteness are both retained whatever the verdict (already true in 0.3.0; covered by new tests for adapter partial runs). |
| Supplement evaluation | The same evaluator, with the supplement's golden expectations; comparison against each case's declared expected verdict, findings, incompleteness and errors; declared expected incompleteness is excluded from the technical-validity check (§2.5) |
| Report schema and summary | `sut`, `profile` and `supplement` blocks; `applicability`, `out_of_scope`, `not_assessed_requirements`, `tested_property` and `family_caveat` per entry; the split counts of §2.4; `contract_acceptance_passed` (every requirement assessed and passed), `profile_acceptance_passed` and `supplement_acceptance_passed`; a separate supplement section; the fixed non-contract statement; a list of uncovered design fences |
| CLI | `run-adapter --lock FILE --profile FILE --out DIR` (drives the pinned runtime over the `IN_PROFILE` cases and the supplement); `evaluate --profile FILE --lock FILE` for imported observations; the exit codes of §2.5. The self-test stays in full-contract mode. |
| Manifest | Adds the lock, profile, supplement, adapter modules and compiled SUT module hashes |
| Limitations | Replace "no pinned ACS or production runtime integration" with a statement of the declared profile, its exclusions and its not-assessed control decisions. Keep "not a production latency claim". State that terminal timing in the profile is harness-chosen, that the audit stream is not evidence, and that supplement expectations marked runtime-specific are not contract expectations. |

## 9. Integration acceptance criteria

1. **Fail-closed pinning.** Pin verification fails closed on a wrong commit, a wrong tree, a dirty worktree, a mismatched `package-lock.json` hash, or a profile/supplement/lock mismatch. A test exists for each.
2. **ACS track untouched.** `sut.lock.json`, `reports/v0.1/` and the ACS adapter are byte-unchanged, and the existing ACS and automotive tests pass unchanged.
3. **Self-test unchanged.** The synthetic revocation self-test passes in full-contract mode, the corpus golden SHA is unchanged, and all existing revocation tests and regressions pass (migrated to 0.4.0 only where the version string requires it).
4. **Classifier and profile.**
   - The classifier output equals the committed profile: 14 `IN_PROFILE` and 13 `OUT_OF_SCOPE` as in §5, unless review decisions R1, R3 or R4 change it.
   - `tested_property` and `family_caveat` are present for every `IN_PROFILE` case of §5.1.
   - A test proves the classifier cannot read observations: it is called before the adapter, and nothing is passed from it.
5. **Acceptance arithmetic.**
   - In declared-profile mode, a run in which every `IN_PROFILE` case and every supplement case match gives `contract_acceptance_passed: false` and exit 3, never 0.
   - A synthetic test with a profile that marks all 27 cases `IN_PROFILE` but still skips K decisions also gives `contract_acceptance_passed: false` and exit 3.
   - Full-contract self-test acceptance still gives exit 0.
6. **Baseline at `a682e44`, declared-profile mode.**
   - All 14 `IN_PROFILE` cases PASS, and the run is technically valid.
   - The supplement matches its declarations: S1–S3 PASS, and S4 UNASSESSABLE with exactly the two declared incomplete entries and no findings or errors.
   - The exit code is 3.
   - The report lists all 27 cases, with coverage 14/27, pass rate 14/14, the not-assessed count, `contract_acceptance_passed: false`, the fixed statement, and the supplement in its own section.
7. **Request discipline.**
   - Every start attempt uses a distinct `request_id` under the authority's original capability.
   - Tests assert that `clearSession()` is never called and no signed request is submitted twice.
8. **Session discipline.** Authorities of one `(tenant, session)` pair share one runtime session and have distinct `capability_id`s. This is checked from the runtime records of `active-session`, `sibling-isolation` and `session-in-flight-commit-fence`.
9. **Determinism.** Two consecutive runs produce byte-identical `observations.json`, `evidence.jsonl` and `report.json`. This requires no timestamps in observations and a fixed clock.
10. **Barrier discipline.**
    - Tests show that a delayed effect after a barrier is caught by the drift check (incomplete), and that a watchdog timeout yields UNKNOWN and never ALLOW or DENY.
    - S4 completes its `finish` barrier on the runtime's `unobservable` state without a timeout.
    - No barrier is implemented as a fixed count of microtask turns (enforced by review).
11. **No back-filling.**
    - An adapter test double that copies an oracle decision for a missing observation is caught.
    - A K decision supplied in an observation is a HARNESS_ERROR.
    - Observations for `OUT_OF_SCOPE` cases are rejected.
12. **Effect independence.**
    - Injected disagreements keep the observed effect and report it as such, never as HARNESS_ERROR from the disagreement alone:
      - a managed state change with a thrown `CommitRejectedError`;
      - a managed state change with a non-`CommitRejectedError` throw;
      - a receipt without a state change;
      - a tool invocation followed by a rejected `process()`.
    - In these tests, a DENY together with a state change yields `unexpected_tool_commit`.
13. **Partial runs.** Each of the following has its own test, with the earlier observations present in the bundle and exit 2. `has_confirmed_violation` is `true` for the two runs with findings and `false` for the run without:
    - An adapter abort or watchdog timeout after a confirmed violating effect yields `complete: false`, verdict **VIOLATION**, `confirmed_violation: true`, and an `incomplete` list that contains the unsealed window.
    - The same with an additional harness error yields verdict **HARNESS_ERROR**, with the finding and the incompleteness both retained.
    - A partial run without any finding or error yields UNASSESSABLE.
14. **Ordering within a step (§4.6).**
    - **M11 trace.** The M11 S4 trace with `seq` (start at a lower `seq` than the terminal, both at step 0) yields VIOLATION `unexpected_execution_terminal`@0, not `causally_impossible`.
    - **Equal `seq`.** The same two effects with equal `seq` yield the incompleteness "effect order not established", neither HARNESS_ERROR nor VIOLATION.
    - **Reversed `seq`.** A terminal with a lower `seq` than its start in the same step yields `causally_impossible`.
    - **Validation.** A `seq` that contradicts step order, a `seq` that points at a probe where the effect is absent, and a `seq` whose predecessor probe already contains the effect each yield `sequence_inconsistent`.
    - **0.3.0 path.** The synthetic self-test, `check:revocation-regressions` and every existing evaluator test produce byte-identical evidence for observations without `seq`, apart from the version string.
15. **Binding.** Every attributed effect is attributed from the runtime's binding. A test injects a mismatched binding and expects an attribution error or a finding, never a PASS.
16. **`cancel_ack` divergence.** A conformance test pins `acknowledgeCancellation() === false` for an already-terminal execution, with that behaviour documented as `cancel_ack_after_runtime_terminal` (R4).
17. **Mutants.**
    - Every SUT mutant of §10 is detected by its fixed witness, as stated in its row.
    - Mutants must typecheck in the SUT (`tsc --noEmit`). Each is applied to a fresh checkout and never committed.
    - Witnesses are fixed in the profile review, before any mutant is run.
    - No mutant is left masked or unreachable; M3 and M11, masked or unreachable in revision 1, are now witnessed by the supplement.

## 10. Planned mutants

**SUT mutants** are type-safe edits applied to a fresh checkout of `a682e44`. The witnesses are expected ones, to be confirmed when the integration review fixes them. "Corpus" witnesses count towards the corpus profile; "supplement" witnesses are reported in the supplement section.

| ID | Mutation | Witness (case @ step: expected detection) | Where |
|---|---|---|---|
| M1 | `#maybeTerminal` ignores pending registered work (a premature terminal when the tool function settles) | `commit-before-cut` @2: `unexpected_execution_terminal` | corpus |
| M2 | The commit binding check skips `deps.revoked()` | `start-before-cut` @2: `false_allow`, `unexpected_tool_commit` | corpus |
| M3 | The commit entry and binding checks ignore the terminal state | S3 @3: `false_allow`, `unexpected_tool_commit`. (In the corpus it is masked by revocation in `deferred-terminal-before-seal` @4.) | supplement |
| M4 | `#handOver` and the result-processing delivery check skip revocation | `session-delivery-fence-after-commit` @3: `false_allow`, `unexpected_output_delivery` | corpus |
| M5 | `revoke()` does not request cancellation of covered executions | `in-flight-before-commit` @2: `false_deny`, `missing_cancellation_ack` | corpus |
| M6 | Session-scope revocation is checked against the capability only | `active-session` @1–2: `false_allow`, `unexpected_execution_started` (both authorities in the revoked shared session) | corpus |
| M7 | A capability revocation is applied to every capability the runtime instance checks (over-reach; in `sibling-isolation` all capabilities share the revoked child's runtime session) | `sibling-isolation` @2 and @7: `false_deny`, `missing_execution_started` (sibling and parent share the revoked child's runtime session) | corpus |
| M8 | The approval-stage and start-stage revocation checks are removed (the request-stage check stays) | S1 @1: `false_allow`, `unexpected_execution_started` | supplement |
| M9 | The request-stage and start-stage revocation checks are removed | `cut-before-start` @1: `false_allow`, `unexpected_execution_started` | corpus |
| M10 | `#maybeTerminal` never records a terminal | `start-before-cut`: missing terminal → UNASSESSABLE, exit 2 (incompleteness witness) | corpus |
| M11 | Restores the pre-`mikko-lab/acs-guardrail-demo#10` premature `failed` terminal for an unobservable settlement | S4 @0: `unexpected_execution_terminal` with the start before the terminal in `(step, seq)` (§4.6); verdict VIOLATION with incomplete {`terminal evidence missing for e1 in window 1..2`}; exit 1; `supplement_acceptance_passed: false` | supplement |

The revision 1 mutant M8 (replay guard disabled) is dropped: the replay construction no longer exists, and no requirement of this profile depends on the replay guard.

**Adapter mutants** are defects in the adapter itself. Each must be caught by the adapter's own tests:

| ID | Defect | Expected detection |
|---|---|---|
| AM1 | Fills a missing decision from the oracle | Back-filling test (§9.11) |
| AM2 | Reports a decision for `finish` or `seal` | HARNESS_ERROR `decision_at_control_step` |
| AM3 | Attributes effects to the intended authority instead of the runtime binding | Binding test (§9.15) |
| AM4 | Uses a fixed microtask count instead of the `deliver` barrier | Drift or timeout test (§9.10): incompleteness |
| AM5 | Treats `whenTerminal()` resolution, or the lock release, as terminal evidence | With M10 applied, and on S4 at the pin, the forged terminal has no probe evidence: HARNESS_ERROR (`effect_without_probe_evidence`), never PASS. |
| AM6 | Drops a commit effect when the commit call threw | Effect-independence test (§9.12) |
| AM7 | Re-submits a signed request or calls `clearSession()` | Request-discipline test (§9.7) |
| AM8 | Gives each authority its own runtime session | Session-discipline test (§9.8); M6 and M7 would no longer be killed |
| AM9 | Assigns `seq` after the run (by array order, by effect kind, or from the corpus order) instead of from the first probe that observed the effect | Probe-log validation (§4.6, §9.14): `sequence_inconsistent` |
| AM10 | Takes no probe inside the tool double's entry function, so start and premature terminal share a `seq` | M11 on S4: the order is not established (extra incompleteness) while the step-based `unexpected_execution_terminal` stays; the incompleteness no longer equals the declaration, so M11's witness (exact incompleteness, exit 1) fails |

## 11. Review decisions

| ID | Decision | Status / recommendation | Consequence if not accepted |
|---|---|---|---|
| R1 | `finish` and `seal` decisions are K (harness control, not assessed), declared uniformly in the profile and counted in `not_assessed_requirements` | Recommended. With revision 2 a K reduction can never yield `contract_acceptance_passed` or exit 0 (§2.4–2.5). | Under the strict reading every case is `OUT_OF_SCOPE`, so the profile is empty. |
| R2 | Replay of the authority's request as a stand-in for single-use permits | **Withdrawn in revision 2.** Every start uses a fresh request under the original capability, and `permit-single-use` is `OUT_OF_SCOPE`. | — |
| R3 | `sibling-isolation` is `IN_PROFILE`, because its revocation target has no descendants; it shows isolation of independent capabilities within one shared runtime session | Accept, with the caveat in §5.1 | It becomes `OUT_OF_SCOPE` (13 in profile), and M7 loses its corpus witness. |
| R4 | `cancel_ack` after a runtime terminal, or without a cancellation request, is a declared unsupported class; the contract keeps ALLOW | Accept, and document the runtime's `false` with a conformance test | The contract would need to change `cancel_ack` semantics, which affects every runtime. |
| R5 | `OUT_OF_SCOPE` corpus cases are not executed in 0.4.0; no diagnostic partial runs | Accept for 0.4.0. Runtime-specific checks go into the reviewed supplement instead. | — |
| R6 | Exit code 3 for an accepted declared profile; exit 0 only when every requirement of all 27 cases is assessed and passes | Accept | A declared profile could pass a 0.3.0-style CI gate. |
| R7 | The supplement (S1–S4) with golden expectations; S2's expectation is runtime-specific; results are reported apart from corpus coverage and the profile pass rate | Accept | M3, M8 and M11 have no witness, and the approval fence is untested. |

## 12. Implementation (integration)

The integration branch implements this specification. Binding clarifications of the integration work order (they override conflicting wording above, which has been aligned):

1. **Ambiguous `seq`** blocks only the order inference concerned and adds an incompleteness entry; the effect still takes part in the step-based evaluation, and other confirmed findings stay (§4.6).
2. **S4's exemption** covers only the versioned, predeclared incompleteness of the supplement file; any other incompleteness or error leads to exit 2 (§2.5).
3. **Partial runs** (§9.13): `has_confirmed_violation` is `false` for the run without findings and `true` for the two with findings; all three exit 2.

| Part | Where |
|---|---|
| Lock and fail-closed loading | `sut.revocation.lock.json`, `src/sut/revocation-lock.ts`, `src/sut/revocation-env.ts` |
| Profile, classifier, supplement (golden) | `profiles/revocation/*.json` + `*.sha256`, `src/profile/revocation/` |
| Adapter, probes, barriers | `src/adapter/revocation-runtime/` |
| Observation semantics (derivation, `seq`) | `src/spec/revocation/runtime-observation.ts`, `schemas/revocation/runtime-observation.schema.json` |
| Evaluator (`probe_seq`, control steps) | `src/eval/revocation/evaluate.ts` |
| Report, exit codes, CLI | `src/report/revocation/profile-report.ts`, `schemas/revocation/profile-report.schema.json`, `src/eval/revocation/runtime-cli.ts` |
| Mutants | `mutations/revocation/M*.patch`, `src/mutation/revocation/` |
| Tests | `test/revocation/runtime-profile.test.ts` (no SUT; committed baseline observations), `test/revocation/runtime-sut.test.ts` (pinned runtime) |

Deviations and refinements found during implementation:

- **Observation shape.** Runtime observations additionally carry the identity mapping (`identity`), the SUT call records (`calls`) and `diagnostics`. The evaluator re-derives effects from the probe log and decisions from the call records and rejects a report that differs (`effect_without_probe_evidence`, `effect_not_reported`, `sequence_inconsistent`, `decision_without_evidence`, `decision_not_reported`). This is how AM1, AM3, AM5, AM6 and AM9 are detected.
- **Case clock.** The SUT stamps its own result requests with the real time, so each case's clock is the real time at case start, held fixed for the case. No timestamp enters an observation; two runs are byte-identical.
- **Drift settle.** Before each step's pre-action probe the adapter yields one macrotask turn, so an effect that arrives after a barrier is caught as drift instead of being bound to the next step.
- **`evaluate --observations FILE --profile FILE --lock FILE`** re-evaluates the recorded corpus and supplement observations of a `run-adapter` bundle without starting the SUT. It uses the same validation and evaluation function as `run-adapter` (`evaluateRecorded`) and the same exit rules; its report is labelled `observation_source: recorded_runtime_adapter_observations` with `sut.build_sha256: null`. An observation for an OUT_OF_SCOPE or unknown case, a missing or duplicate case, or a malformed envelope is an input error (exit 2, no report).
- **Terminal and commit evidence (review of `521139c`).** Each probe records, besides the execution state, the snapshot's own terminal record, the executor's terminal log (`terminals()`), the managed-state `version` and, per key, the value `get(key)` returned. A terminal is an effect only when the state is `terminal`, the snapshot's record names the same execution and the terminal log has exactly one entry for it. A commit is an effect only when its key is listed, `get(key)` returns the written value, and the version grew by at least one per new commit. Any other combination is contradictory state evidence: it is reported as incompleteness (`inconsistent state evidence ...`), never as an effect and never as a PASS; a delivery after a commit with contradictory evidence is incomplete rather than causally impossible. API receipts and exceptions never replace or remove a state observation.
- **Scope of contradictory evidence (reviews of `a98e16e` and `29d7a82`).** A contradiction concerns one fact: its effect kind (`tool_commit` or `execution_terminal`), its execution (none when the fact names no observed execution, e.g. a `terminals()` entry for an unknown ID, which then covers every execution) and the first probe that shows it. A contradictory fact is never observed again as an effect, so it leaves unconfirmed (rather than missing) every expected effect of the same kind and execution whose window was still open at that probe. A window ending at step `l` closes at the last barrier-bound probe (not `pre_action` or `seal_settle`) of a step `<= l`, which is the last probe at which an effect of that window can first appear. A window closed by its barrier without the effect stays closed: a contradiction first shown after it, at the next `pre_action`, at a later step or at `seal_settle`, does not reopen it, and the missing effect stays a confirmed finding. A delivery is incomplete rather than causally impossible only when a contradictory commit of its execution was first shown no later than the delivery's own probe. Every other expected effect is evaluated as usual. Examples (`commit-shift-across-cut`, commit expected at step 1, window closed by probe 4 = step 1 `barrier_complete`): a key without its value first shown at step 2 `pre_action` or at `seal_settle` leaves `missing_tool_commit@1` confirmed (VIOLATION with incompleteness, `has_confirmed_violation: true`, exit 2); the same key first shown at step 0 `barrier_complete`, step 1 `pre_action` or step 1 `barrier_complete` leaves the commit unconfirmed (UNASSESSABLE, never PASS). A terminal contradiction first shown at `seal_settle` is after the terminal window's last barrier (step 4): `terminal evidence missing for e1 in window 2..5`.
- **Adapter mutants that need SUT behaviour the pinned runtime does not show** (AM3: a mismatched runtime binding; AM6: a write at a denied commit) apply that behaviour to a real baseline observation and re-report it as the adapter would. AM1 uses a 0 ms watchdog to produce UNKNOWN decisions for the back-filling defect to fill.
- **Mutant patch forms.** M2, M4 and M6 use always-false conditions or a never-matching lookup so that the patched file typechecks in the SUT (a mutant that does not typecheck is a technical failure, never a kill).

## 13. Revision for the v0.5.0 pin (coverage expansion package 1)

This revision applies the approved [coverage expansion plan](coverage-expansion-plan.md), package 1 (G1 tenant scope, G2 descendant coverage), to the pin `acs-guardrail-demo` v0.5.0 at `a9deab6709d6ca2ba8f3988693b50fa807eadc0c`. Sections 1–12 describe the `a682e44` pin; where they conflict with this section for the new pin, this section applies. The [SUT pin review](sut-pin-review-a9deab6.md) records the results.

### 13.1 Lock

`sut.revocation.lock.json` pins commit `a9deab6…`, tree `dc25f122…`, version `0.5.0`, package-lock SHA-256 `6d40e36d…` and the baseline of 30 suites / 628 tests (`npm run verify`, Node 22 and 24). New, optional fields, validated fail closed when present:
- **`sut_tag`** `{ name: "v0.5.0", object: "f0626086…" }`: the annotated tag is an additional identifier. Its name must be `v<sut_version>`, its object a 40-hex SHA other than the commit. Before every checkout the tag is fetched into a harness-only ref and must be that object, of type `tag`, pointing at `sut_commit`. A disagreeing tag fails closed. The commit and the content hashes stay the SUT identity; the tag never selects what runs.
- **`sut_runtime_mode`** `tenancy` (absent: `legacy`, the earlier pin) and **`max_chain_length`** 8 (tenancy mode only; legacy forbids it). The built runtime must export exactly that `MAX_CHAIN_LENGTH`.
- **`runtime_test_gates`**: the runtime's own mutant gates (tenant, ancestor) with their manifests' SHA-256, report paths, expected exits, the detected mutants per evidence kind and the recorded coverage gaps, and the gate regressions R1–R4 with each case's exit. The checkout verification also checks both manifests' SHA-256.

The earlier lock is kept byte for byte in `profiles/revocation/history/`, with its profile, supplement and recorded format 1 observations. The adapter refuses a lock that is not in tenancy mode or a profile that does not bind observation format 2 (exit 2); `evaluate --observations` still re-evaluates the earlier pin.

### 13.2 Identity mapping in tenancy mode

| Contract identity | Runtime identity (v0.5.0, `CapabilityGrantVerifier(..., { tenancy: true })`) |
|---|---|
| Tenant `t` | One runtime tenant id `ace-tenant-<uuid>` per contract tenant, unique within the case. It is carried only by issuer-signed version 2 grants; the runtime reads it from the verified grant, never from request metadata. |
| Pair `(t, s)` | One runtime session per pair, as before. Pairs of one session name in two tenants are two runtime sessions. |
| Authority `x` | A version 2 grant with `tenant_id` of `x`'s tenant, bound to the session of `x`'s pair. Its tools are its own tool plus the tools of its descendants (attenuation: a child's tools are a subset of its parent's). Validity windows are nested by depth, so a child's window lies inside its parent's. |
| Authority `x` with parent `p` | The grant names `parent: { capability_id, fingerprint }`, the fingerprint being the SHA-256 of the canonical grant body of `p` without its signature. Parents are issued before children. The capability provider answers with the complete chain envelope `{ kind: "capability_chain", leaf, ancestors }` (parent first). |

The observation's `identity` declares the mapping: `capabilities`, `sessions`, `tenants` (runtime tenant → contract tenant) and `chains` (runtime capability → its supplied ancestor capabilities, parent first). The evaluator checks it against the case (`identity_mapping_invalid`: one capability per authority, one runtime session per pair, a bijection of tenants, every chain equal to the contract ancestry), checks every observed execution's runtime binding (`tenant_id`, `ancestor_capability_ids`) against the mapping of its capability (`runtime_binding_mismatch`), and checks the probe log's revocation receipts (`revocation_target_mismatch`, §13.3). The adapter never infers coverage from the parent links it knows: coverage is observed in the runtime's decisions and state.

### 13.3 Revocations

A contract revocation is exactly one runtime revocation of its mapped target: an authority revocation is one capability revocation of the target's capability (which covers its descendants in the runtime, `ancestor_revoked`), a session revocation one session revocation, a tenant revocation one `{ scope: "tenant", tenant_id }` revocation. Neither a tenant nor an ancestor revocation is ever expanded into session or child revocations. Every receipt in the probe log must belong to a revoke step, at most one per step, and acknowledge exactly that step's target; otherwise the case is a HARNESS_ERROR (`revocation_target_mismatch`). A withheld delivery counts as a revocation denial for the codes `capability_revoked`, `session_revoked`, `tenant_revoked` and `ancestor_revoked`. Decisions and effects stay separate: a receipt, a withheld code or an audit event never replaces state evidence.

### 13.4 Runtime observation format 2

`schemas/revocation/runtime-observation-2.schema.json` (`format: "revocation-runtime-observation/2"`) adds, compatibly with format 1: the `format` field, `identity.tenants` and `identity.chains` (required), the tenant runtime target, and `tenant_id` and `ancestor_capability_ids` on every execution record. A profile binds its format (`observation_format`); another format is `observation_format_mismatch`. Format 1 observations are validated with the unchanged format 1 schema and evaluated without the format 2 checks, so the earlier pin's recorded observations and their regressions are unchanged. The terminal three-record check, the commit key/value/version evidence, probe-bound `seq` and barrier-bounded contradiction scoping apply unchanged; `unobservable` stays missing terminal evidence and `whenTerminal()` is never awaited without a bound.

### 13.5 Profile and supplement

The profile `acs-guardrail-demo-a9deab6/revocation-0.4.0/3` declares the revoke scopes `authority_with_descendants`, `session` and `tenant`; the classifier derives its capability rules from them alone. `tenant-multi-session-in-flight`, `tenant-isolation` and `derived-in-flight-ancestor-revoked` move into the profile (17 IN_PROFILE / 10 OUT_OF_SCOPE). `derived-authority` stays OUT_OF_SCOPE (it needs G3). `sibling-isolation` now maps its parent links, so it shows that revoking `child` reaches neither its parent nor its sibling, and its family caveat is removed. The unassessed finish/seal decisions rise from 34 to 43. The supplement `…/supplement/2` keeps S1–S4 unchanged and adds S5–S10 (plan §7.4); it is reported apart from corpus coverage.

### 13.6 Mutants

The eval mutant gate reads `mutations/revocation/manifest.json` (golden SHA-256 in `manifest.sha256`), bound to the pinned SUT, profile and supplement. Per mutant it fixes the patch and its SHA-256, the single target file, the source of a patch copied byte for byte from the runtime's own gate, the evidence kind, the witness case and its exact verdict, decision findings, effect findings, incompleteness, evaluator errors and run exit with the reason for that exit. It also predeclares, case by case and exactly, every technical exception the whole mutant run shows (`run_exceptions`): the evaluator errors (case, code, path, message) and the adapter barrier timeouts (case, step, detail). Only M4 (one `causally_impossible` in `in-flight-before-commit`) and M10 (its 24 finish-barrier timeouts) predeclare any.

The gate checks every whole run for technical errors **before** it classifies the mutant. A case inventory other than the control's, a harness process diagnostic (`adapter_abort`, `setup_failed`, `constructor_getter_ran`), or any evaluator error or barrier timeout in any case beyond the predeclared ones is a technical failure (exit 2), whatever the witness shows. Only then is the mutant detected: exactly the witness values, exit and `has_confirmed_violation`, and every predeclared exception present. A witness case and exit equal to the control's is a survivor. Anything else is a technical failure, never a kill. The control run must show no evaluator error, barrier timeout or harness process error at all. A patch that does not apply, changes another file or does not typecheck aborts the gate as a technical failure.

**Gate regressions** (`mutations/revocation/gate-regressions.json`, golden SHA-256; `node dist/scripts/mutant-gate-regressions.js`, in CI) run the real pinned runtime. They can edit one mutant run's observations before evaluation (`mutants --only <M> --inject FILE`). Such a run is labelled a regression input and is never evidence.

| Case | Input | Required gate result |
|---|---|---|
| G1-m1-unchanged | M1 | detected, exit 0 |
| G2-m1-malformed-other-case | M1, plus a field the schema forbids in `issued-permit` | technical failure, exit 2 (`unexpected harness error issued-permit malformed_observation`) |
| G3-m10-extra-timeout | M10, plus one barrier timeout in `issued-permit` at step 1 | technical failure, exit 2 (`unexpected barrier timeout issued-permit@1`) |
| G4-m4-extra-error-other-case | M4, plus a malformed observation in `start-before-cut` | technical failure, exit 2 |
| G5-m10-unchanged | M10 | detected, exit 0 |

| Evidence | Mutants |
|---|---|
| Corpus witness | M1, M2, M4–M7, M9, M10 (earlier), M15, M16, M21, M22, M37 (package 1) |
| Supplement witness | M3, M8, M11 (earlier), M20 (S5), M26 (S7), M34 (S8), M28 and M29 (S9), M35 and M36 (S10) |
| Adapter | AM1–AM10 (earlier), AM11 (tenant revoke as session revokes: `revocation_target_mismatch`), AM12 (pairs of one session name in two tenants on one runtime session: `identity_mapping_invalid`), AM13 (parent links dropped: `identity_mapping_invalid`, and S5's start allowed) |
| Runtime-own tests | The pinned runtime's tenant gate (19) and ancestor gate (25) and the gate regressions R1–R4, run by `runtime-gates` in a verified checkout and compared with the lock; reported separately, never as corpus or supplement evidence |

M15, M16, M20–M22, M26, M28, M29 and M34–M36 are the runtime gate's own patches, copied byte for byte. **M37 differs from the runtime gate's M37:** the runtime's patch propagates a revocation to the parent and siblings when `revoke()` is called. In `sibling-isolation` the child is revoked before any capability is bound, so that patch has nothing to propagate to. The eval's M37 walks the revoked capability's lineage at check time instead (a revoked capability whose parent chain contains the checked capability or one of its ancestors covers it), which is the same defect reached through the contract.

## 14. Revision for the v0.6.0 pin (approval–permit lifecycle, G3/G4)

This revision applies the eval step (§10, step 4) of the approved [approval–permit lifecycle plan](approval-permit-lifecycle-plan.md) to the pin `acs-guardrail-demo` v0.6.0 at `ef775dbff6c5691b4b2d44611b22eb33c431f451`, in tenancy mode with the opt-in lifecycle (`{ lifecycle: "permit" }`). Sections 1–13 apply where this section does not replace them. The [SUT pin review](sut-pin-review-ef775db.md) records the results.

### 14.1 Lock

`sut.revocation.lock.json` pins commit `ef775db…`, tree `7eb9f336…`, version `0.6.0`, the annotated tag `v0.6.0` (object `c83cd669…`), package-lock SHA-256 `b8be5394…`, `max_chain_length` 8 and the SUT baseline of 33 suites / 774 tests. New:
- **`sut_lifecycle_mode`** `permit` (absent: `legacy`, the earlier pins). Permit mode is pinned with tenancy mode only. A permit-mode lock must pin the lifecycle gate, its regressions and its determinism check; a legacy lock must not.
- **`runtime_test_gates.lifecycle`**: the runtime's lifecycle mutant gate (`npm run mutants:lifecycle`, manifest `mutants/lifecycle/manifest.json`, SHA-256 `80952ae5…`) with its own evidence kinds: `both`, `containment_effect`, `check_point`, `component_check_point`, `lifecycle_effect`, `check_and_lifecycle`, `availability_effect`, `check_and_availability`. The lock also pins the gate's counts (26 entries, 20 patches and mechanisms, 6 variants, 41 witness tests), its variants (M58, M61 and M62 with inputs (i) and (iii)), the entries with labels beyond their claimed kind and the recorded gaps.
- **`runtime_test_gates.lifecycle_regressions`** RL1–RL24 with each case's gate exit, and **`lifecycle_determinism`** (three identical witness runs).

The tenant and ancestor gate bindings are those of the `a9deab6` pin, byte for byte (their manifests are unchanged at `ef775db`). The shared gate driver of `ef775db` reports all eight evidence kinds for every gate. A kind outside a gate's own kinds is accepted only when its list is empty; an unknown or non-empty one is a technical failure (`evidenceKindIssues`). `runtime-gates` reports containment, lifecycle, availability, check-point-only and component-only evidence in separate lists and never merges them. The `a9deab6` lock moves to `profiles/revocation/history/` with its profile, supplement and recorded format 2 observations. The adapter refuses any lock that is not tenancy plus permit mode, and any profile that does not bind observation format 3 (exit 2). `evaluate --observations` still re-evaluates both earlier pins under their historical locks.

### 14.2 Lifecycle mapping

| Contract | Runtime (permit mode) |
|---|---|
| Authority `x` (any `initial`) | One lineage, created at setup by `process(r)`: `r` is `x`'s fixed request, with the ASK tool `update_record`, under `x`'s grant chain. The Guardian answers ASK, so the lineage starts `pending`. Every grant allows exactly `update_record`. |
| `initial: issued` | At setup, also `approve(g)` with a signed human `ApprovalGrantV3`, then `issuePermit({ lineage_id })`. |
| `approve(x)` | `approve(g)`. `g` is a version 3 grant built from the runtime's own lineage snapshot: lineage, session, request id, tool, `request_digest` and `authority_fingerprint`; approver `human/demo-operator`. |
| `issue(x)` | `issuePermit({ lineage_id })` |
| `start(x, e)` | `start({ lineage_id, request })` with a fresh signed request R′: a new request id, `x`'s tool and exactly the lineage's arguments |
| `revoke`, `commit`, `deliver`, `cancel_ack`, `finish`, `seal` | Unchanged (§§3, 13). `commit` and `cancel_ack` use the context of the execution that `start()` ran. |

- **Request marker.** The runtime binds the arguments by digest (D5), so the request marker in the arguments is fixed per authority (`ace-authority:<id>`). The tool double therefore takes the execution label from the runtime's own record of the execution: `getExecution(id).request_id` is the R′ of exactly one start step, whose execution is the label. The adapter's step counter is never used.
- **Setup failures.** A setup call that does not return a pending lineage, or a setup approve or issue that throws, is `setup_failed`. That is a harness process error, never a decision, and no mutant manifest can predeclare it.
- **What the adapter never does** (plan §9). It keeps no lifecycle state of its own and never decides a lifecycle denial. It never grants, issues, consumes or revokes a permit on the runtime's behalf. It never re-creates a lineage after a denial. It never reports the setup state as an effect.

### 14.3 Setup baseline and lifecycle effects

The setup ends with one **`setup_baseline`** probe, the first probe of the log (step 0). In format 3, every probe records:
- every lineage snapshot (`lineages()`): its states, sequence values, permit and execution ids and bindings, but no timestamp;
- the shared authority sequence value (`authoritySequence()`, `authority_seq`).

The baseline's value is `baseline_seq`.

- **The baseline only confirms the initial state.** Every authority has exactly one lineage in the baseline, in its `initial` state:
  - `pending`: approval pending and no permit;
  - `issued`: approved and an issued, unconsumed permit, both with sequence values ≤ `baseline_seq`.

  Each lineage is also bound to its authority's capability, session pair, tenant and supplied chain. Anything else is `identity_mapping_invalid`: a lineage in another state, a missing or extra lineage, a lineage that appears after the setup, a lineage whose bindings change, no baseline probe, or more than one.
- **A lifecycle effect is a post-baseline transition** between consecutive probes:
  - `approval_granted` is `approval_state` changing from `pending` to `approved`;
  - `permit_issued` is `permit_state` changing from `none` to `issued`, or on to `consumed` in the same interval.

  The transition's own sequence value (`approved_seq`, `issued_seq`) must lie after `baseline_seq` and inside the interval in which it is first shown: after the previous probe's `authority_seq`, at most this probe's. The effect's step is that probe's step and its `seq` the probe index. Its provenance is `sut_state`. A transition first shown at `pre_action` or `seal_settle` is drift. A state already present at the baseline is never an effect.
- **Contradictory transitions.** A transition with a sequence value outside that interval, or none, is contradictory state evidence. No effect is derived from it, and the expected effect of its kind stays unconfirmed (incomplete), never missing. An example is a setup-time approval that surfaces after the baseline.
  - **Scope.** The contradiction concerns only its own lineage's authority (`identity.lineages`) and, for a consumption, the execution it names when an observed execution has that id. An expected effect of another authority is never left unconfirmed by it: a missing effect of that authority stays a finding (for example, a contradictory permit sequence of `a` never hides `missing_permit_issued@5` of `b`). The temporal scope is unchanged: it concerns an expected effect only while that effect's window is still open at its probe (closed by the window's last barrier probe, §12).
- **Regressions of the log** (`sequence_inconsistent`): an approval or permit state that moves backwards, a lineage that disappears, or an `authority_seq` that decreases.
- **Permit consumption.** `permit_state` changing to `consumed` is no contract effect. It is checked for attribution in both directions (§14.5).
- **No other source of lifecycle effects.** A receipt, a return value or an audit record is never an effect.

### 14.4 Decisions

The decision is the answer of the step's own lifecycle call:

| Call | ALLOW | DENY | Anything else |
|---|---|---|---|
| `approve` | returned (receipt) | `AuthorityRevokedError`, or `LifecycleDeniedError` with reason `not_pending` | UNKNOWN |
| `issuePermit` | returned (receipt) | `AuthorityRevokedError`, or `LifecycleDeniedError` with reason `not_approved` | UNKNOWN |
| `start` | the tool double was entered | `AuthorityRevokedError`, or `LifecycleDeniedError` with reason `permit_not_issued` or `permit_consumed` | UNKNOWN |

Other lifecycle denials are no contract answer, so they are UNKNOWN. These are binding or snapshot mismatches, provider errors, expiry and verification failures. In format 3, the call record carries the denial `reason` and, for `start`, the R′ `request_id`. A call whose API is not its operation's own (`approve`, `issuePermit`, `start`, `revoke`, `commit`, `deliver`, `acknowledgeCancellation`) is `call_api_mismatch`.

### 14.5 Attribution checks

- **`lifecycle_transition_mismatch`** (HARNESS_ERROR). Every post-baseline transition shown at a step barrier must occur at a step whose own runtime call can make it:
  - an approval at an `approve` step of the lineage's authority, with an `approve` call;
  - an issue at an `issue` step, with an `issuePermit` call;
  - a consumption at a `start` step, with a `start` call. The consumption's `start_request_id` must be that call's R′, and its `execution_id` the execution that step started.

  A consumption whose `execution_id` no observed execution has is also `lifecycle_transition_mismatch`: it is never skipped.

  This catches an adapter that approves, issues or consumes on the runtime's behalf (AM18).
- **Start without its own consumption** (incomplete, never PASS). The other direction: every observed start (a tool-double entry) needs the permit consumption of its own authority's lineage, first shown at the start's own step, whose `execution_id` is that execution and whose `start_request_id` is that step's R′. Without it (no consumption, a consumption first shown at another step, or one naming another execution or request) the start's state evidence is inconsistent. The case reports it as incomplete (`inconsistent state evidence (probe k): start:L: execution started with no permit consumption of its own: …`) and the expected start of that execution and authority stays unconfirmed. Findings already shown stay: an unexpected start is still a finding.
- **`runtime_binding_mismatch`**, in addition to §13.2. Every execution record's runtime `request_id` must be the R′ of exactly one start step, and that step must start the record's label.
- **`identity_mapping_invalid`**, in addition to §13.2. The identity mapping declares `lineages` (runtime lineage → contract authority): exactly one lineage per authority (AM17), confirmed by the baseline (§14.3, AM15).

### 14.6 Runtime observation format 3 and compatibility

`schemas/revocation/runtime-observation-3.schema.json` (`format: "revocation-runtime-observation/3"`) extends format 2 with:
- `identity.lineages` (required);
- the `setup_baseline` probe point;
- per probe `lineages` and `authority_seq` (required);
- per execution record its `request_id` (required);
- the call APIs `approve`, `issuePermit` and `start` in place of `process` and `resolveApproval`;
- per call `reason` and `request_id`.

Lineage snapshots carry no timestamps. Additional fields are refused.

**Compatibility.**
- **The contract stays `revocation-0.4.0`.** Format 3 is a new observation format revision, not a contract change. A profile binds exactly one format, and another format is `observation_format_mismatch`.
- **Formats 1 and 2 are validated with their unchanged schemas and evaluated by the unchanged rules.** The format 3 checks run only on format 3 observations. Two common definitions changed:
  - `approval_granted` and `permit_issued` now have `sut_state` provenance. They were never derived in formats 1 and 2.
  - `setup_baseline` is a drift point. It never occurs in formats 1 and 2.
- **Verified.** At this pin, the recorded `a9deab6` observations re-evaluate to byte-identical `evidence.jsonl`, `supplement-evidence.jsonl` and `observations.json`, and the recorded `a682e44` observations to their earlier results (both exit 3).

### 14.7 Profile v4 and supplement v3

**Profile `acs-guardrail-demo-ef775db/revocation-0.4.0/4`** binds observation format 3. It declares `supported.lifecycle`: `initial_pending_authority`, `approve`, `issue`, `single_use_permit`. The classifier reads these capability rules from the profile, besides the revoke scopes. A profile declares lifecycle rules exactly when it binds format 3.
- **Coverage: 23 IN_PROFILE / 4 OUT_OF_SCOPE.** The cases that move in are `pending-approval`, `issue-after-cut`, `fresh-id-retry-unused-permit`, `derived-authority`, `permit-single-use` and `approval-before-cut`. The four that stay out need G5 or G6.
- **K = 57 unassessed finish/seal decisions.**
- **27 newly assessed decisions** (plan §6, corrected from 28). In `approval-before-cut`, step 5 is a finish, which is K, so 6 of its 8 decisions are assessed. In all, the six cases have 41 decisions, 14 of them K. The coverage target is unchanged: neither the corpus nor the oracle changes.
- **Removed caveats.** The family caveats of `issued-permit`, `cut-before-start` and `duplicate-revocation` ("no permit object") are removed: their authorities now start with a real, unused permit.
- **Design fences.** The only fence still uncovered is "execution identity".

**Supplement `…/supplement/3`** (S1–S14), reported apart from corpus coverage:
- **S1, S2, S7 and S8** are re-mapped from the legacy `approve_starts` to approve, issue and start steps. S2's expectation is now the contract oracle's, no longer runtime-specific: approval is its own operation.
- **S3–S6, S9 and S10** keep their content byte for byte.
- **S11–S14** are new, as in plan §7.3.
- Every expectation is the contract oracle's.

### 14.8 Mutants

**Manifest.** `mutations/revocation/manifest.json` has version `revocation-sut-mutants/3`. Each entry pins the evidence parts its witness shows. The parts are derived from the pinned values and checked by the loader:
- **containment:** an unexpected start, commit or delivery, or a side effect after the terminal;
- **lifecycle:** an unexpected approval or permit; never containment;
- **availability:** a missing start, commit, delivery, approval or permit;
- **signal:** cancellation and revocation acknowledgements, and premature or unexpected terminals;
- **check point:** decision findings only;
- **missing evidence.**

`mutants.json` lists each part separately. The eval gate has no component evidence. Plan §8.1 rows also pin the plan's kind and a note where the parts differ.

**Masked mutants.** A mutant that changes a check no case can reach under the pinned mode is pinned as `masked`. Its whole run must equal the control: the exit, every case's evidence and the diagnostics. It is a recorded gap, never a detection. A masked run that differs is a technical failure.

**Mutants not run.** `not_run` lists a plan mutant with a recorded conflict, its reproduction and the coverage gap it leaves. It is never evidence. This is M25 (§14.9).

**Named mechanisms.** A mutant id is `M<n>`, or `M<n>-<name>` for a separately authorized mechanism. `M25-overreach` (§14.9) is such a mechanism: a new mutant, not a variant of M25.

**Gate regressions.** G1–G5 are unchanged. G6–G8 are new:

| Case | Input | Required gate result |
|---|---|---|
| G6-m8-masked | M8 | masked, exit 0 |
| G7-m8-masked-differs | M8, plus a barrier timeout in `pending-approval` | technical failure, exit 2 |
| G8-m12-setup-failed | M12, plus `setup_failed` in `issued-permit` | technical failure, exit 2 (a setup failure is never predeclarable) |

**Adapter mutants AM14–AM19** (plan §8.3) are run against the real build:

| Mutant | Defect | Detection |
|---|---|---|
| AM14 | start refused by the adapter | `decision_without_evidence` |
| AM15 | pending authority issued at setup | `identity_mapping_invalid` |
| AM16 | lifecycle effects taken from receipts, with an injected snapshot that hides the approval | `effect_without_probe_evidence`; the correct report is not PASS |
| AM17 | two lineages for one authority | `identity_mapping_invalid` |
| AM18 | approve and issue after a denied start | `lifecycle_transition_mismatch` |
| AM19 | setup state reported as step-0 effects | `effect_without_probe_evidence` |

AM1–AM13 are re-verified under permit mode.

### 14.9 Regressions AR1–AR4 and the M25 conflict

AR1–AR4 (plan §7.6) are tests in `test/revocation/runtime-permit.test.ts`. They edit the recorded `ef775db` observations, then re-derive the report from the edited probes:

| Regression | Input | Result |
|---|---|---|
| AR1 | `permit-single-use` with the AM19 report | HARNESS_ERROR `effect_without_probe_evidence` for both effects; the correct report is PASS |
| AR2 | `pending-approval` with an approved baseline | `identity_mapping_invalid`; no lifecycle effect from the baseline |
| AR3 | `approval-before-cut` with `approved_seq` ≤ `baseline_seq` | inconsistent state evidence, `approval_granted@0` unconfirmed, UNASSESSABLE, never PASS |
| AR4 | `issue-after-cut` with the permit first shown at the revoke step | `lifecycle_transition_mismatch` |

**M25 is not run (decided).** The plan's M25 is an over-fencing control: issue requires `pending` instead of `approved`. Its patch also denies the setup issue of every `initial: issued` authority (`not_approved`). Every case with such an authority then fails its setup (`setup_failed`), so the whole mutant run is a technical failure, never a detection.
- A setup failure is never accepted as a safety finding.
- A mutant is never switched off for the setup.
- M25 stays under `not_run`, with its reproduction.
- **Coverage gap.** The loss of the issue state requirement has no eval mutant evidence. The requirement itself is still observed (for example, `pending-approval` step 2), and the runtime-own test L10 asserts it.

**`M25-overreach` (separately authorized).** It changes the issue fence only: a session revocation of another session of the same tenant also covers the issued lineage.
- **Witness:** S11 step 5. The uncovered authority `b` (`t1`, `s2`) is issued after the session (`t1`, `s1`) is revoked: ALLOW in the control, DENY under the mutant.
- **Setup.** It runs unchanged runtime API calls; no revocation precedes it.
- **Evidence kind:** unjustified denial at a check point of the lifecycle right to a permit (availability). It is never containment.
- It is a new mechanism. It is neither evidence of the original M25 property nor a variant of the M25 patch.
