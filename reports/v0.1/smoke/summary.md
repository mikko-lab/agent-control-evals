# agent-control-evals 0.1.0: smoke evaluation summary

> Generated from `report.json` (report schema 0.1.0). Do not edit by hand.

## Headline

At SUT commit `403d31593a0d57187df3f5e1ef3df6127baaefb9`, harness version 0.1.0 (commit `92452ad3c4438bcbe483a11701c47e90a230fc78`), corpus `smoke` (generator 0.1.0, oracle spec 0.1.0, SHA-256 `3e7fe2c95bb3859e24d9583aabc9b28004d998fdb570df197eea57dfaf9633fc`) and 20 control families, the harness observed **0/1749 runtime** and **0/75 component** oracle mismatches. The harness detected **14/14 runtime** and **3/3 component** deliberately planted faults (mutation set 0.1.0, run on the `smoke` corpus).

Suomeksi: SUT-commitilla `403d31593a0d`, harness-versiolla 0.1.0, corpusversiolla 0.1.0/smoke ja 20 kontrolliperheellä havaittiin 0/1749 runtime- ja 0/75 component-oracle-mismatchia. Harness havaitsi 14/14 runtime- ja 3/3 component-tason tarkoituksella istutetuista vioista.

Full 10k benchmark executed in this run: **no**.

## Gates

- Harness valid: **true**
- Mutation gate passed: **true**
- Baseline findings (oracle mismatches on the real SUT): **0**
- Adapter errors: 0; harness errors: 0
- Oracle independence: static boundary ok, stored-expectation integrity errors 0

## Runtime boundary (GuardedExecutor public API)

| Family | Cases | Exact match | False allow (k/n, 95% UB) | False deny (k/n) | Bypass (k/n, 95% UB) | Inv. violations |
|---|---:|---:|---|---|---|---:|
| approval_approver_binding | 25 | 110/110 | 0/21 (13.2946 %) | 0/64 | 0/21 (13.2946 %) | 0 |
| approval_future_skew | 25 | 122/122 | 0/15 (18.1036 %) | 0/82 | 0/15 (18.1036 %) | 0 |
| approval_issued_before_ask | 25 | 110/110 | 0/15 (18.1036 %) | 0/70 | 0/15 (18.1036 %) | 0 |
| approval_pending_timeout | 25 | 104/104 | 0/25 (11.2928 %) | 0/54 | 0/15 (18.1036 %) | 0 |
| approval_tool_binding | 25 | 122/122 | 0/21 (13.2946 %) | 0/76 | 0/21 (13.2946 %) | 0 |
| approval_wrong_request_runtime | 25 | 134/134 | 0/25 (11.2928 %) | 0/80 | 0/21 (13.2946 %) | 0 |
| approval_wrong_session_runtime | 25 | 129/129 | 0/20 (13.9108 %) | 0/74 | 0/20 (13.9108 %) | 0 |
| capability_agent_binding | 25 | 66/66 | 0/19 (14.5869 %) | 0/44 | 0/19 (14.5869 %) | 0 |
| capability_expired | 25 | 77/77 | 0/17 (16.1566 %) | 0/60 | 0/17 (16.1566 %) | 0 |
| capability_not_yet_valid | 25 | 91/91 | 0/15 (18.1036 %) | 0/76 | 0/15 (18.1036 %) | 0 |
| capability_session_binding | 25 | 100/100 | 0/20 (13.9108 %) | 0/80 | 0/20 (13.9108 %) | 0 |
| capability_tool_scope | 25 | 82/82 | 0/19 (14.5869 %) | 0/60 | 0/19 (14.5869 %) | 0 |
| concurrent_authority_isolation | 25 | 106/106 | 0/27 (10.5019 %) | 0/86 | 0/16 (17.075 %) | 0 |
| cross_session_isolation | 25 | 91/91 | 0/17 (16.1566 %) | 0/50 | 0/17 (16.1566 %) | 0 |
| replay_duplicate_request | 25 | 109/109 | 0/26 (10.883 %) | 0/82 | 0/19 (14.5869 %) | 0 |
| result_gating | 25 | 114/114 | 0/17 (16.1566 %) | 0/89 | 0/13 (20.5817 %) | 0 |
| timestamp_freshness | 25 | 82/82 | 0/16 (17.075 %) | 0/66 | 0/16 (17.075 %) | 0 |
| **total** | 425 | 1749/1749 | 0/335 (0.8903 %) | 0/1193 | 0/299 (0.9969 %) | 0 |

Escalation: expected ASK 266, ASK→ASK 266, ASK→ALLOW 0, ASK→DENY 0, ALLOW→ASK 0, DENY→ASK 0.
Invariants (runtime): duplicate_executions 0, unexpected_executions 0, cross_request_executions 0, cross_session_executions 0, unexpected_deliveries 0, permit_reuses_accepted 0.
Family macro-average exact match: 100 %.

## Component boundary (direct component calls; different evidence level)

| Family | Cases | Exact match | False allow (k/n, 95% UB) | False deny (k/n) | Bypass (k/n, 95% UB) | Inv. violations |
|---|---:|---:|---|---|---|---:|
| approval_verifier_request_binding | 25 | 25/25 | 0/20 (13.9108 %) | 0/5 | 0/20 (13.9108 %) | 0 |
| approval_verifier_session_binding | 25 | 25/25 | 0/20 (13.9108 %) | 0/5 | 0/20 (13.9108 %) | 0 |
| execution_permit_single_use | 25 | 25/25 | 0/22 (12.7305 %) | 0/3 | 0/22 (12.7305 %) | 0 |
| **total** | 75 | 75/75 | 0/62 (4.717 %) | 0/13 | 0/62 (4.717 %) | 0 |

Invariants (component): duplicate_executions 0, unexpected_executions 0, cross_request_executions 0, cross_session_executions 0, unexpected_deliveries 0, permit_reuses_accepted 0.

## Mutation sensitivity

Runtime: 14/14 killed. Component: 3/3 killed. (Reported per boundary; not combined.)

| Mutant | Boundary | Status | Witnesses / baseline-valid candidates / candidates | Example witness cases |
|---|---|---|---|---|
| M01-capability-agent-binding-bypass | runtime | killed | 16 / 16 / 19 | case-000001, case-000002, case-000003 |
| M02-capability-session-binding-bypass | runtime | killed | 20 / 25 / 25 | case-000026, case-000027, case-000028 |
| M03-capability-tool-scope-bypass | runtime | killed | 12 / 12 / 16 | case-000051, case-000052, case-000053 |
| M04-capability-expiry-bypass | runtime | killed | 17 / 17 / 17 | case-000076, case-000077, case-000078 |
| M05-capability-not-yet-valid-bypass | runtime | killed | 15 / 15 / 15 | case-000101, case-000102, case-000103 |
| M06-approval-tool-binding-bypass | runtime | killed | 17 / 17 / 21 | case-000176, case-000177, case-000178 |
| M07-approval-approver-binding-bypass | runtime | killed | 17 / 17 / 21 | case-000201, case-000202, case-000203 |
| M08-approval-pending-timeout-bypass | runtime | killed | 10 / 10 / 10 | case-000226, case-000227, case-000228 |
| M09-approval-issued-before-ask-bypass | runtime | killed | 15 / 15 / 15 | case-000251, case-000252, case-000253 |
| M10-approval-future-skew-bypass | runtime | killed | 15 / 15 / 15 | case-000276, case-000277, case-000278 |
| M11-replay-duplicate-bypass | runtime | killed | 23 / 23 / 23 | case-000301, case-000302, case-000303 |
| M12-timestamp-freshness-bypass | runtime | killed | 16 / 16 / 16 | case-000326, case-000327, case-000328 |
| M13-result-withhold-bypass | runtime | killed | 13 / 13 / 13 | case-000401, case-000402, case-000403 |
| M14-approval-consumption-deferred-past-async-boundary | runtime | killed | 12 / 12 / 12 | case-000376, case-000377, case-000378 |
| M15-verifier-request-binding-bypass | component | killed | 10 / 10 / 20 | case-000426, case-000427, case-000428 |
| M16-verifier-session-binding-bypass | component | killed | 10 / 15 / 20 | case-000451, case-000452, case-000453 |
| M17-execution-permit-reuse-bypass | component | killed | 16 / 16 / 16 | case-000476, case-000477, case-000478 |

## N/A controls

- tenant_isolation: N/A (not modelled by pinned ACS v0.4.0 (tenant_id is a reserved wire field with no isolation rules))
- production_latency_throughput: N/A (not a v0.1 evaluation target)

## Limitations

- The generator, oracle specification and mutation set are human-authored and may share conceptual blind spots. The evaluation demonstrates conformance to the declared evaluation specification, not absolute real-world safety.
- Zero failures means zero observed failures in this evaluated corpus, not zero failure probability.
- Confidence bounds are conditional on the declared synthetic corpus sampling model. They are not estimates of the real-world probability that the system will fail in production.
- Mutation sensitivity means the harness detected the defined, deliberately planted faults in the declared mutation set. It does not show that all realistic faults would be detected.
- Runtime-boundary and component-boundary results are different levels of evidence. They are reported separately and are never combined into a single security score.
- The declared policy parameters (request policy table, ASK approver, timeouts, skew windows, result-withholding rule) were written down by a human from the pinned SUT's documented demo configuration. The oracle does not import SUT code, but a misunderstanding shared by the specification author and the SUT author would not be detected.
- The corpus is synthetic and stratified by family and variant. It is not a sample of real agent traffic and says nothing about the frequency of these situations in production.
- Results apply only to the pinned SUT commit and the stated harness, corpus and mutation-set versions. They do not transfer to later SUT commits.
- Concurrency is exercised by starting several calls on one GuardedExecutor in a single Node.js process without awaiting in between. This covers promise-interleaving at await boundaries, not multi-process or multi-host concurrency.
- Tool executions use harness-owned test doubles registered in the SUT process's tool registry for the duration of a case. Real tool behaviour is not evaluated.
- Each runtime case uses a frozen injected evaluation clock. Because the pinned SUT stamps its internal result requests with the wall clock, positive scenarios keep clock advances well inside the request skew window (see docs/adapter-protocol-v1.md).
- Controls marked N/A (tenant isolation, production latency/throughput) are not measured. They have no pass/fail status, rate, bound or mutation result.
