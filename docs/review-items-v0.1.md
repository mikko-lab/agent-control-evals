# Open review items for v0.1 (draft review)

## Status after the fix commits (pending independent review)

The analysis below is kept as written against `92452ad`/`fd1bcdf`. The fixes are separate, scoped commits on top of `fd1bcdf`. **They change measurement semantics and need independent review; they do not close the findings by themselves.**

| Item | Fix commit | What changed | Still open |
|---|---|---|---|
| A1 adapter masking | `5a087f5` | Decision and effect are kept apart. An observed execution is never an `AdapterError`: outcomes follow the effect, the SUT's report is kept in `sut_decision` with `decision_effect_mismatch`, and every disagreement is listed in `decision_effect_mismatches`. A post-execution-looking exception without an execution becomes a flagged REJECT, never an EXECUTE (no false kills). Remaining `AdapterError`s keep partial evidence (`raw_sut_evidence.partial`, `observed_executions`). Adapter 0.2.0, taxonomy 0.1.1. | Result delivery is still taken from the SUT's return value; there is no independent effect channel for delivery. Attribution of fallback-tool executions within concurrent request steps is per attempt window and can be ambiguous. |
| B1 statistical unit | `f092859` | Bounds only on scenario proportions (`scenario_outcome_mismatch`, `false_allow`, `false_deny`, `bypass`), with k counting members of n and `bound()` rejecting k > n. Assertion counts are descriptive only. Report schema 0.2.0. | The binomial model still assumes the declared equally weighted variant mixture (documented in `docs/evaluation-spec.md` §10–11). |
| B2 breadth | `f092859` | `variant_coverage` per boundary and family: variants, failures per variant, mean replication, with no bound. The headline leads with scenarios and variants. | Breadth is limited to the designed variants (102 runtime, 17 component). No bound is offered beyond them, by design. |
| A1 follow-up: decision/effect integrity as a metric | `e01583f` | Each decision point has an `effect_record` (SUT report, SUT decision, result-control decision, authorised and observed executions, authorised and observed raw deliveries). Deliveries are now observed structurally (raw tool output found in the returned value) instead of from `exit_status`. The report has `decision_effect_integrity` (unauthorized_execution, unauthorized_delivery, missing_expected_effect, umbrella) per boundary, with case IDs, k / eligible scenarios and `confidence_bound: not_applicable`. Adapter 0.3.0, report schema 0.3.0. | Delivery observation recognises only an exact raw output, not transformed or partial leaks. Fallback-tool executions are not attributable to a request. Concurrent result-control decisions come from `exit_status`. |
| Review of `e01583f` (FIX_BEFORE_FULL_BENCHMARK): H1, H2, M1, M2, M3, L1, L2 | `e677679` | **H1:** ALLOW / ASK / DENY by the Guardian only from the call's own `guardian_decision` audit event; approval EXECUTE only from `human_approval`, REJECT from `human_rejection` / `approval_verification_failed` / `approval_expired` or a classified freshness exception; permit EXECUTE only from the gate's `tool_execution_started`. A return status, returned value or exception class alone never grants authority; without evidence the decision is `DECISION_NOT_OBSERVED` and the effect is kept. **H2:** `exit_status` is no longer a decision source (raw evidence only). Result control comes only from attributed `result_guardian_decision` events: per-call window for single calls; for concurrent calls a link through the SUT's own signed result request (`request_id_ref`). **M1/M3:** explicit observation states (`observed`, `not_observed`, `ambiguous`, `unavailable`) and sources (`harness_tool_trace`, `sut_counter`, `return_value_scan`, `none`) per channel; the SUT fallback counter is used only when one call can have caused the delta, consistently for request and approval steps. Each integrity category has its own eligible set; `decision_not_observed`, `ambiguous_effect_observation` and `unavailable_effect_observation` are reported separately and never enter a clean denominator. **L1:** every audit lookup is windowed to the call (or step); regression test for a stale `replay_rejected` of the same request id. **M2:** README, adapter protocol and evaluation spec §12 state exactly what is detected (exact raw output, also inside wrappers; not partial, transformed, semantic or DLP-type leakage). **L2:** contract tests for authority independence, observation states and the existing invariants. Adapter 0.4.0, harness 0.1.3, report schema 0.4.0 (0.3.0 kept as historical schema). | Concurrent attempts on one request id with differing (or partly missing) Result Guardian decisions are `ambiguous` (3 scenarios under M11 in smoke). Signature, schema, freshness and gate rejections have no SUT audit event and are `sut_exception`-sourced (they grant nothing). L3 (empty capability queue → `AdapterError`) unchanged. Delivery detection limits as in `docs/evaluation-spec.md` §12.4. |
| Review of `e677679` (FIX_BEFORE_FULL_BENCHMARK): MEDIUM-1..3, LOW-1, LOW-3, LOW-5, LOW-6 | (this commit) | **MEDIUM-1:** real-SUT regression tests prove that concurrent Result Guardian decisions stay attributable to the originating request (requests and approvals, DELIVER vs WITHHOLD, both orders, checked against the single-call ground truth); they fail when the `request_id_ref` linkage is removed. **MEDIUM-2:** an `unavailable` or `ambiguous` delivery observation excludes the scenario from the clean denominators of `unauthorized_delivery`, `missing_expected_effect` and the umbrella (component gate scenarios: N/A there). **MEDIUM-3:** mutant integrity tallies are reported per boundary (`integrity_scenarios.by_boundary`, `primary_boundary`), never pooled under `--boundary all`. **LOW-1:** DELIVER + WITHHOLD on one decision point is `ambiguous`, never resolved by a min/max/first/last rule. **LOW-3:** a 0-eligible category renders as N/A in the summary (JSON keeps `rate_descriptive: null`). **LOW-5/LOW-6:** README claim narrowed to permissive decisions; observation-source trust (`harness_tool_trace` stronger, `sut_counter` weaker and SUT-owned) documented. Adapter 0.4.1, harness 0.1.4, report schema 0.5.0 (0.4.0 kept as historical). | Backlog below (LOW-2, LOW-4). |
| C clock boundary | not changed | A coverage limit, documented below. | Approvals in (240 s, 300 s], late or long-session executions and long-interval replay remain unmeasured. |

### Backlog after the review of `e677679` (not freeze-blocking; no new safety features)

- **LOW-2 (approval stray-key delivery).** In an approval step, an execution of a request that no attempt targeted is a definite `unauthorized_execution`, but whether its raw output appeared in another attempt's returned value is not scanned (its record shows `delivery_observation: not_observed` without a scan), and in a single approval every key of the step sees the step's Result Guardian events. Only reachable when an unauthorised execution is already reported. Not observed in smoke or in any mutant run.
- **LOW-4 (L1 test scope).** The L1 regression test fails when audit windowing is removed, but through the inherited `guardian_decision` of step 1, not through the stale `replay_rejected` its name describes (the Guardian evidence is checked first). Separate windowing tests for `replay_rejected`, `timestamp_rejected` and `capability_rejected` lookups do not exist.
- **INFO (unchanged):** concurrent decisions are read from the call's synchronous prefix (a decision recorded after an `await` becomes `DECISION_NOT_OBSERVED`, fail-safe); an empty capability queue is an `AdapterError` (L3); the Result Guardian linkage trusts the SUT's own `request_id_ref`.

Historical reports in `reports/v0.1/**` are unchanged and still validate against `schemas/report.schema.0.1.0.json`. No new 10k run was made after the fixes.

Line references are to commit `92452ad3c4438bcbe483a11701c47e90a230fc78`. The referenced files are unchanged in `012ae23` and later documentation-only commits. These items are **reported, not fixed**: each fix would change measurement semantics and needs a separate review.

## A. Adapter masking

### How the outcomes are distinguished today

| Category | Where | Mechanism |
|---|---|---|
| Expected SUT rejection | `src/adapter/acs/runtime.ts:189-211` (process), `:213-224` (resolveApproval); `src/adapter/acs/component.ts:64-77` (verifier), `:136-144` (gate) | Fixed table of SUT error classes, codes, exact messages and audit-reason metadata mapped to canonical reason classes. Produces DENY or REJECT observations. |
| Unexpected SUT exception | `runtime.ts:210`, `:223`, `:268`; `component.ts:67`, `:143` | Throws `AdapterError`. `src/adapter/acs/main.ts:39-41` turns it into `status: "adapter_error"` with `observations: null`. `src/eval/run.ts:86-88` records an adapter error and **no verdict**, so the run becomes invalid (exit 2). `src/mutation/runner.ts:131-134`: a mutant with adapter errors and no valid witness is `invalid`, never `killed`. |
| Adapter's own error (state or protocol) | `runtime.ts:232`, `:237`, `:244`, `:289`, `:326`, `:348`, `:401`; `tool-doubles.ts` (`ToolStateLeakError`); `src/eval/client.ts` (protocol or timeout leads to a harness or protocol error) | Same `AdapterError` path, or a harness/protocol error that stops the run. |
| Observed execution (effect) | `src/adapter/acs/tool-doubles.ts` (log of `{tool, trace}`); `runtime.ts:416-422` (per-request `executions`, `unattributed_executions` including ACS `unknownToolMock`) | Kept as separate observation fields (`observations.executions`, `unattributed_executions`) next to the decision observations (`observations.assertions`). The comparator checks them as invariants (`src/eval/compare.ts:183-209`). |
| Observed result release | `runtime.ts:226-245` | Derived from the SUT's returned result (`exit_status` and the withheld representation). There is no independent effect channel for delivery. |

### Finding A1: an observed unauthorised execution can be turned into `AdapterError` (latent, major)

In three places, an execution observed through the tool doubles that **contradicts** the SUT's reported decision is converted into an `AdapterError` instead of being reported as an unauthorised execution:

1. `runtime.ts:266-268`: the tool ran during `process()`, then the SUT threw an exception that is not a known post-execution class (for example `Execution blocked (deny)`). This is effectively "DENY, but executed".
2. `runtime.ts:279`: `process()` returned `pending` (ASK), but the tool already ran. That is execution without approval.
3. `runtime.ts:403-411`: the step-level consistency check. Any mismatch between ALLOW/EXECUTE observations and observed executions in a step raises an error, including a REJECT or DENY while the tool ran.

Consequences:

- The case gets `observations: null` (`main.ts:41`), so the tool-double evidence of the unauthorised execution is **discarded** rather than kept next to the decision.
- It is **not** a silent pass. A baseline adapter error invalidates the run (exit 2), and a mutant whose only deviations are such adapter errors is `invalid` (mutation gate failure), not `survived` or `killed`.
- It **is** a misclassification. A real control bypass would be reported as an adapter/infrastructure problem instead of a false allow or bypass finding. A mutant that causes a genuine bypass of this shape could not be credited as killed.
- **Effect on the committed results: none observed.** Both committed reports have 0 baseline adapter errors and 0 adapter errors in every mutant run (`mutation_sensitivity.by_mutant[*].mutant_adapter_errors = 0`), so none of these paths was taken.

Related inaccuracy in the documentation: `docs/adapter-protocol-v1.md` says executions are "observed through the harness tool doubles, not inferred from return values". That holds for request ALLOW (`runtime.ts:284`). Approval EXECUTE and REJECT (`runtime.ts:308-331`) are classified from the SUT's return or throw, and are only cross-checked against the doubles by the step check in (3).

Proposed direction (**not applied**): record the decision (SUT-reported) and the effect (double log, per attempt where attributable) as separate fields for every step. A restrictive decision together with an observed execution becomes a `decision_effect_mismatch` observation, which the comparator scores as a false allow / bypass with the evidence kept. Reserve `AdapterError` for behaviour that is unclassifiable *and* shows no unauthorised effect.

## B. Statistical experimental unit

Code: `src/eval/metrics.ts:79-117` (counting), `:119-130` (bounds), `src/eval/stats.ts:36-71`; allocation `src/corpus/generate.ts:28-46`.

| Metric (bound) | k counts | n counts | Unit | Dependent checks within a scenario | Stratification |
|---|---|---|---|---|---|
| `oracle_mismatch` (`metrics.ts:124`) | assertions not exactly matched | all evaluated assertions (`v.checks`) | **assertion** | Several assertions per scenario (request plus result, setup steps, approval steps, concurrent multisets) are counted as separate trials. **Not independent.** | Pooled over the strata. |
| `false_allow` (`metrics.ts:125`) | `false_allow` mismatches (`compare.ts:78`, plus unexpected permissive observations at `compare.ts:120` and `:153`) | assertions with a restrictive *expected* outcome | **assertion** | Same problem. In addition, k can include observations **without** a corresponding expected assertion, which are not part of n, so k is not a count of failures among the n units. | Pooled. |
| `false_deny` (`metrics.ts:126`) | `false_deny` mismatches | assertions with a permissive expected outcome, **including setup preconditions** inside adversarial scenarios | **assertion** | Dependent, and n mixes primary and setup checks. | Pooled. |
| `bypass` (`metrics.ts:127`) | adversarial scenarios with a false allow or an authority/data invariant violation (`compare.ts:207-209`) | adversarial scenarios | **scenario (case)** | One verdict per scenario; dependent checks are collapsed. | Pooled; equal allocation per family, then per variant. |

### When the binomial model holds

Within a variant, the cases are seeded pseudo-random draws of the scenario parameters, so they are approximately i.i.d. draws from that variant's parameter distribution. The SUT is deterministic. With fixed equal allocation, a pooled k/n per family is a binomial proportion for "a scenario drawn from the declared, equally weighted variant mixture" (up to ±1 rounding of the allocation). The `bypass` bound is valid **for that synthetic mixture only**.

### Finding B1: assertion-level bounds treat dependent checks as independent trials (major)

`oracle_mismatch`, `false_allow` and `false_deny` use assertions as Bernoulli trials. Assertions within one scenario are strongly dependent. A request that wrongly executes produces a wrong request outcome, a wrong result outcome and often wrong later steps together. The binomial independence assumption fails, and these upper bounds are too narrow. The `false_allow` numerator can also contain events outside its denominator (`compare.ts:120`, `:153`). If that ever made k > n, `clopperPearsonUpper` would throw (`stats.ts:37`), and report generation would fail with a harness error instead of reporting the finding. This has not happened in the committed runs (k = 0 everywhere).

### Finding B2: the case count overstates evidence breadth (major)

The SUT's control logic is mostly a deterministic function of the variant's *structure*. The random parameters rarely change the outcome, so a defect usually affects all or none of a variant's cases. The number of cases mainly measures replication; the breadth of evidence is closer to the number of variants (102 runtime, of which 70 adversarial; 17 component, of which 14 adversarial). A bound such as a 0.03 % upper bound over 8 500 runtime cases is mathematically valid for the mixture but must not be read as evidence about situations outside the 102 designed variants. The disclaimer does not fix this.

Proposed direction (**not applied**):

- Compute bounds only on scenario-level units (one Bernoulli per case, defined on the primary assertion plus invariants), per variant and per family.
- Report variant-level coverage, meaning the number of variants with at least one failure, as the primary breadth statistic, with no binomial bound attached.
- Drop the assertion-level bounds, or relabel them as descriptive counts.

## C. Clock boundary

### Mechanism

- The harness clock is frozen per case: `src/adapter/acs/runtime.ts:340-341` (`base = Date.now()` at case start, `offset` advanced only by `advance_clock`, `:394`). It is injected into `ReplayGuard`, `GuardedExecutor` and `CapabilityGrantVerifier` (`:355-363`).
- The pinned SUT stamps its internally generated result request with the wall clock: `acs-guardrail-demo@403d315 src/guarded-executor.ts:391` (`timestamp: new Date().toISOString()`). It then checks it with the replay guard, which uses the injected clock (`src/guarded-executor.ts:330`, `src/replay-guard.ts:147-148`, window ±300 000 ms).
- Hence, for any execution, the result request's delta is approximately `-(virtual offset) - (real ms elapsed in the case)`. If the virtual offset exceeds about 300 s, the result path fails with `TIMESTAMP_OUT_OF_WINDOW` after the tool already ran. That is an artefact of the injected clock, not of production behaviour, where both clocks coincide.
- Mitigation: `src/spec/declared-policy.ts:40` `MAX_POSITIVE_CLOCK_ADVANCE_MS = 240_000`, used by `src/corpus/builders.ts:105-106` for every scenario that must still execute after a clock advance (`families-runtime-approval.ts:184`, `:191`; `families-runtime-other.ts:44`). The 60 s margin absorbs real elapsed time within a case.

### Time scenarios not measured because of this

1. A successful approval with elapsed time in (240 s, 300 s], including the inclusive boundary of exactly 300 000 ms. Only the rejecting side, timeout plus 1 ms or more, is measured.
2. Any execution or result delivery after a cumulative virtual advance above 240 s within a scenario. Examples are long-lived pending actions approved late, and requests issued late in a long session.
3. Replay detection long after the original request, beyond the 300 s skew window. This is the property that replay state is session-scoped rather than time-pruned. `duplicate_after_clock_advance` uses `positiveAdvance` (at most 240 s) although no execution follows, so this case is limited unnecessarily (a corpus design gap, not a SUT finding).
4. Wall-clock behaviour of the SUT itself (`Date.now()` defaults) is not exercised; the adapter always injects a clock.

### Determinism claim limits

`--check-observation-determinism` shows that two runs of this corpus on the same machine and Node version produced byte-identical observations. It does **not** show determinism for all timing or concurrency situations. Concurrency is limited to calls started in the same tick of a single Node process, interleaved at `await` boundaries with tool doubles that resolve immediately. Real tool latency, timers, multiple processes and different event-loop schedules are not covered.
