# Evaluation specification v0.1

Versions: generator `0.1.0`, oracle spec `0.1.0`, reason taxonomy `0.1.0`, case schema `0.1.0`, mutation set `0.1.0`, adapter protocol `1`, report schema `0.1.0` (`src/version.ts`).

This document is the human-authored specification that the oracle (`src/oracle/expected.ts`) implements. **The oracle is a model of this document, not of the SUT's code.** It never imports, executes or reads SUT code or SUT/adapter output.

> The generator, oracle specification and mutation set are human-authored and may share conceptual blind spots. The evaluation demonstrates conformance to the declared evaluation specification, not absolute real-world safety.

## 1. Control matrix

Source of truth: `src/spec/control-matrix.ts`. The matrix is emitted into every report.

| Control | Boundary | Family | v0.1 |
|---|---|---|---|
| capability_agent_binding | runtime | capability_agent_binding | measured |
| capability_session_binding | runtime | capability_session_binding | measured |
| capability_tool_scope | runtime | capability_tool_scope | measured |
| capability_expired | runtime | capability_expired | measured |
| capability_not_yet_valid | runtime | capability_not_yet_valid | measured |
| approval_request_binding_verifier_invariant | component | approval_verifier_request_binding | measured |
| approval_session_binding_verifier_invariant | component | approval_verifier_session_binding | measured |
| wrong_request_approval_runtime_rejection | runtime | approval_wrong_request_runtime | measured |
| wrong_session_approval_runtime_rejection | runtime | approval_wrong_session_runtime | measured |
| approval_tool_binding | runtime | approval_tool_binding | measured |
| approval_approver_binding | runtime | approval_approver_binding | measured |
| approval_pending_timeout | runtime | approval_pending_timeout | measured |
| approval_issued_at_before_ask_creation | runtime | approval_issued_before_ask | measured |
| approval_excessive_future_issued_at | runtime | approval_future_skew | measured |
| execution_permit_single_use | component | execution_permit_single_use | measured |
| replay_duplicate_request | runtime | replay_duplicate_request | measured |
| timestamp_freshness | runtime | timestamp_freshness | measured |
| cross_session_authority_isolation | runtime | cross_session_isolation | measured |
| concurrent_authority_isolation | runtime | concurrent_authority_isolation | measured |
| result_gating_withholding | runtime | result_gating | measured |
| tenant_isolation | N/A | none | N/A: not modelled by the pinned ACS v0.4.0 |
| production_latency_throughput | N/A | none | N/A: not a v0.1 target |

Each family maps to exactly one control, so "per family" means "per control". Each family contains adversarial variants (expected restrictive outcome) and at least one positive control variant (expected permissive outcome), so false allows and false denies are both measurable.

## 2. Case model

A case is an evaluation scenario, not necessarily one request (`src/corpus/types.ts`, `schemas/case.schema.json`). Runtime scenarios are sequences of steps: `request`, `approve`, `concurrent_request`, `concurrent_approve`, `advance_clock` and `clear_session`. Component scenarios target `approval_grant_verifier` or `execution_gate`.

- Identifiers are opaque labels (`s1`, `q1`). The adapter maps them deterministically to SUT identifiers. A request label maps to the same `request_id` in every session, which lets the scenarios express "same request id in another session".
- Time is always an integer millisecond offset relative to the evaluation clock **at the time of the step**. The corpus contains no absolute times.
- `tamper` on a grant means "the approval authority signed these values, then field F was rewritten".
- The case schema belongs to the harness and is not the ACS wire schema.

## 3. Outcomes before reasons

`expected.outcome` is mandatory. `acceptable_reason_classes` is optional and may hold several classes. A case passes its primary assertion when the outcome matches. A reason outside the acceptable set is reported separately as a `reason_mismatch` (evidence mismatch). That is not an outcome failure and never kills a mutant.

**Rule:** when several independent controls each forbid the same action, every violated control's reason class is acceptable. Examples:

- An expired capability for the wrong agent gives `DENY` with {`CAPABILITY_AGENT_MISMATCH`, `CAPABILITY_EXPIRED`}.
- A grant tampered after signing gives `REJECT` with {`INVALID_SIGNATURE`, the mismatch class of the tampered field}. If the rewritten pair points at no pending action, `PENDING_ACTION_NOT_FOUND` is also acceptable.
- At runtime, an approval presented for a request it was not issued for gives `REJECT` with {`PENDING_ACTION_NOT_FOUND`, `INVALID_SIGNATURE`, `APPROVAL_REQUEST_MISMATCH`}, whichever fail-closed mechanism fires. The runtime oracle **does not** require the verifier's `REQUEST_MISMATCH`/`SESSION_MISMATCH`, because the pinned `resolveApproval` looks up the pending action by `${grant.session_id}:${grant.request_id}` before the verifier sees a trusted context.

## 4. Normalised outcomes

| Stage | Outcomes | Notes |
|---|---|---|
| request | ALLOW, ASK, DENY | Pre-Guardian fail-closed rejections (signature, replay, freshness, capability) normalise to DENY. The report keeps `enforcement_stage`, `reason_class` and `sut_reason_code`, so a Guardian DENY and a replay rejection stay distinguishable. |
| approval | EXECUTE, REJECT | EXECUTE means the tool ran during the approval call. |
| result | DELIVER, WITHHOLD | WITHHOLD means the raw output did not reach the caller (policy withhold, or a fail-closed error after execution). |
| verifier (component) | ACCEPT, REJECT | |
| permit (component) | EXECUTE_ONCE, REUSE_BLOCKED, REUSE_ACCEPTED, REJECT | Derived from how many attempts with the same permit executed. |

Concurrency uses explicit invariants rather than outcomes. These are executions per request, duplicate executions, cross-request and cross-session executions of attack targets, unexpected deliveries and accepted permit reuses.

## 5. Declared policy parameters (`src/spec/declared-policy.ts`)

Provenance: written down by a human from the pinned SUT's documented demo configuration (README of the pinned SUT, ACS v0.1.0 §10.3, and the demo Guardian's documented behaviour). The oracle does not import them from the SUT. The same values are used to configure the SUT in the adapter (skew windows), so a misconfiguration would surface as findings rather than be hidden.

| Parameter | Value |
|---|---|
| request skew window | ±300 000 ms, inclusive (rejected iff \|delta\| > window) |
| request policy | `read_record` → ALLOW, `update_record` → ASK, any other tool → DENY |
| ASK approver | human `demo-operator` |
| ASK timeout | 300 000 ms; rejected iff elapsed > timeout |
| approval future skew | 30 000 ms; rejected iff issued_at > now + skew |
| result rule | output value is an object whose top-level `classification` is exactly `"restricted"` → WITHHOLD |

## 6. Runtime oracle rules

**Request step (declared pipeline: authentication, then freshness and replay, then capability, then policy).**

1. Violations before the capability check: `REQUEST_SIGNATURE_INVALID` (tampered request), `TIMESTAMP_OUT_OF_WINDOW`, and `REPLAY_DETECTED` (the request label was already accepted in this session).
2. A request id is recorded as seen once authentication and freshness pass, regardless of later capability or policy outcome. A stale attempt therefore never poisons its id.
3. If there are no pre-capability violations, the capability is checked. The violations are `CAPABILITY_MISSING`, `CAPABILITY_INVALID_SIGNATURE`, `CAPABILITY_UNSUPPORTED_SCOPE` (wildcard), `CAPABILITY_MALFORMED` (expires <= issued), `CAPABILITY_NOT_YET_VALID` (now < issued), `CAPABILITY_EXPIRED` (now >= expires), `CAPABILITY_AGENT_MISMATCH`, `CAPABILITY_SESSION_MISMATCH` and `CAPABILITY_TOOL_MISMATCH` (no exact match).
4. Any violation gives DENY, with every violation acceptable. Otherwise the declared policy applies: ALLOW executes and produces a result assertion, and ASK creates a pending action stamped with the current clock.

**Approval step.**

1. The effective grant is the grant after any post-signature rewrite.
2. No pending action at the effective (session, request) gives REJECT `PENDING_ACTION_NOT_FOUND`, plus the tamper reasons if tampered.
3. Otherwise the binding violations are checked: tamper reasons, a tool different from the pending tool, and an approver other than the declared approver. The freshness violations are checked too: `APPROVAL_BEFORE_ASK` (issued < ASK creation), `APPROVAL_FUTURE_SKEW` and `APPROVAL_EXPIRED`.
4. Pending state: binding failures preserve the pending action, and expiry consumes it (pinned SUT README: "pending approval and rejection/expiry state are consumed fail closed"). Where the declared spec does not determine the state, the oracle marks it unknown and **refuses** to derive later steps that depend on it, instead of guessing.
5. A valid `reject` gives REJECT `HUMAN_REJECTED` and consumes the pending action. A valid `approve` gives EXECUTE, consumes it, and adds a result assertion based on the original request's tool output.

**Concurrent steps** are modelled sequentially in list order. The comparison is order-agnostic: a multiset of outcomes per (step, stage), with every observed reason required to be in the union of acceptable reasons. Declared invariant (pinned SUT README): duplicate concurrent approval consumes the pending authority at most once.

**clear_session** releases that session's replay state and pending actions only.

## 7. Component oracle rules

- **ApprovalGrantVerifier.verifyV2(grant, context)**: REJECT if the signature is invalid, or the session, request, tool or approver differs from the trusted context (tamper rule as above). Otherwise ACCEPT.
- **ExecutionGate permit**: a minted permit authorises at most one execution, and only of the exact (session, request, tool) it was minted for. A forged permit authorises nothing. One matching attempt gives EXECUTE_ONCE. Several matching attempts, sequential or concurrent, give REUSE_BLOCKED with `permit_reuses_accepted = 0`.

## 8. Reason taxonomy

Source of truth: `src/spec/reason-taxonomy.ts` (versioned and emitted into every report). Adapters return both `reason_class` (canonical) and `sut_reason_code` (raw). The oracle and comparator only ever use canonical classes. `CROSS_SESSION_MISMATCH` is reserved: ACS has no dedicated code for it, so cross-session attacks are detected through the binding classes and the cross-session invariant.

## 9. Corpus

- Canonical JSON Lines: UTF-8, LF, recursively sorted keys, no whitespace, integers only, generation order (family, then variant, then index), and exactly one final LF. `corpus_sha256` covers exactly these bytes. The manifest is a separate file and is not hashed into itself.
- Determinism: content depends only on (generator version, seed, family, variant, index within variant). The SHA-256-counter PRNG uses integer arithmetic only. There is no wall clock, UUID randomness, environment or file-order dependence (tested under different `TZ` and `LANG`).
- Stratification: equal cases per family (±1), then equal cases per variant (±1). Smoke profile: 500 cases with seed `ace-v0.1-smoke`. Full profile: 10 000 cases with seed `ace-v0.1-full`.
- Corpus validity checks at generation time:
  1. Each variant's intended outcome must equal the oracle's (double entry).
  2. Adversarial variants cannot have a permissive expected outcome.
  3. Every adversarial case's acceptable reasons must include one of its family's target controls (`src/spec/family-targets.ts`), so no variant is "blocked" only by an unrelated control.
  4. Every mutant has at least 3 smoke witness candidates.

## 10. Metrics (report schema 0.2.0)

Metrics are computed per boundary, family and variant (`src/eval/metrics.ts`). There is no aggregate security score.

**Statistical unit: the scenario (one case).** Every metric that carries a confidence bound is a proportion of scenarios, and its numerator counts only scenarios that are members of its denominator, so k ≤ n by construction. `bound()` refuses anything else.

| Bounded metric | k | n |
|---|---|---|
| `scenario_outcome_mismatch` | scenarios with any outcome or invariant mismatch | evaluated scenarios |
| `false_allow` | scenarios in n with a false allow (restrictive expectation, permissive observation) or a permissive invariant violation (unexpected execution or delivery, permit reuse, cross-request or cross-session execution) | scenarios with at least one restrictive expected assertion |
| `false_deny` | scenarios in n whose primary observation was restrictive | scenarios whose primary expected outcome is permissive |
| `bypass` | adversarial scenarios with a false allow or an authority/data invariant violation | adversarial scenarios |

Other quantities are reported without bounds:

- **Descriptive assertion counts.** These are matched and evaluated assertions, assertion-level false allows and false denies, reason and decision/effect mismatches, and the escalation transitions ASK→ASK, ASK→ALLOW, ASK→DENY, ALLOW→ASK and DENY→ASK. The assertions of one scenario are dependent (a wrong request outcome drags its result and later steps with it), so they are never treated as independent trials. An expected DENY that becomes ASK is an unexpected escalation, not a false allow.
- **Variant coverage (evidence breadth).** This covers the number of designed variants (and how many are adversarial or positive), the variants with any outcome failure, the adversarial variants with a bypass, the positive variants with a false deny, and the mean number of cases per variant. Cases within a variant are seeded replicates of one structure, so a defect usually affects all or none of them. **Breadth is the number of variants, not the number of cases.**
- **Permissive deviations outside the false_allow denominator.** These are permissive deviations in scenarios with no restrictive expectation, counted separately and never added to `false_allow`.
- **Invariant totals**, and the number of scenarios with decision/effect disagreements.

Cases with adapter errors are not evaluated. They are listed as errors together with any executions observed before the error, make the run invalid, and never enter a denominator. Family macro-averages are given so that no family dominates.

## 11. Statistics

The bound is the exact binomial (Clopper–Pearson) one-sided 95 % upper bound on each scenario proportion (`unit`, `k`, `n`, `observed_rate`, `one_sided_95_upper_bound`), plus `rule_of_three ≈ 3/n` when k = 0. Test vectors come from an independent exact-rational reference (`scripts/stats_reference.py`).

Sampling model: within a variant, cases are seeded pseudo-random draws of that variant's parameters, and allocation is fixed and equal per family, then per variant. A bound therefore refers only to "a scenario drawn from this declared, equally weighted variant mixture". It says nothing about situations outside the designed variants.

> Confidence bounds are conditional on the declared synthetic corpus sampling model. They are not estimates of the real-world probability that the system will fail in production.
