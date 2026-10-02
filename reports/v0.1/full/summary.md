# agent-control-evals 0.1.0: full evaluation summary

> Generated from `report.json` (report schema 0.1.0). Do not edit by hand.

## Headline

At SUT commit `403d31593a0d57187df3f5e1ef3df6127baaefb9`, harness version 0.1.0 (commit `92452ad3c4438bcbe483a11701c47e90a230fc78`), corpus `full` (generator 0.1.0, oracle spec 0.1.0, SHA-256 `23fc91db905dd544f46bf7dad162a324d4d43ac740228e341fb7291495b5548b`) and 20 control families, the harness observed **0/34640 runtime** and **0/1500 component** oracle mismatches. The harness detected **14/14 runtime** and **3/3 component** deliberately planted faults (mutation set 0.1.0, run on the `full` corpus).

Suomeksi: SUT-commitilla `403d31593a0d`, harness-versiolla 0.1.0, corpusversiolla 0.1.0/full ja 20 kontrolliperheellä havaittiin 0/34640 runtime- ja 0/1500 component-oracle-mismatchia. Harness havaitsi 14/14 runtime- ja 3/3 component-tason tarkoituksella istutetuista vioista.

Full 10k benchmark executed in this run: **yes**.

## Gates

- Harness valid: **true**
- Mutation gate passed: **true**
- Baseline findings (oracle mismatches on the real SUT): **0**
- Adapter errors: 0; harness errors: 0
- Oracle independence: static boundary ok, stored-expectation integrity errors 0

## Runtime boundary (GuardedExecutor public API)

| Family | Cases | Exact match | False allow (k/n, 95% UB) | False deny (k/n) | Bypass (k/n, 95% UB) | Inv. violations |
|---|---:|---:|---|---|---|---:|
| approval_approver_binding | 500 | 2243/2243 | 0/417 (0.7158 %) | 0/1326 | 0/417 (0.7158 %) | 0 |
| approval_future_skew | 500 | 2170/2170 | 0/300 (0.9936 %) | 0/1370 | 0/300 (0.9936 %) | 0 |
| approval_issued_before_ask | 500 | 2188/2188 | 0/300 (0.9936 %) | 0/1388 | 0/300 (0.9936 %) | 0 |
| approval_pending_timeout | 500 | 2144/2144 | 0/500 (0.5974 %) | 0/1144 | 0/300 (0.9936 %) | 0 |
| approval_tool_binding | 500 | 2255/2255 | 0/417 (0.7158 %) | 0/1338 | 0/417 (0.7158 %) | 0 |
| approval_wrong_request_runtime | 500 | 2474/2474 | 0/500 (0.5974 %) | 0/1390 | 0/417 (0.7158 %) | 0 |
| approval_wrong_session_runtime | 500 | 2738/2738 | 0/400 (0.7461 %) | 0/1638 | 0/400 (0.7461 %) | 0 |
| capability_agent_binding | 500 | 1581/1581 | 0/358 (0.8333 %) | 0/1152 | 0/358 (0.8333 %) | 0 |
| capability_expired | 500 | 1646/1646 | 0/334 (0.8929 %) | 0/1312 | 0/334 (0.8929 %) | 0 |
| capability_not_yet_valid | 500 | 1772/1772 | 0/300 (0.9936 %) | 0/1472 | 0/300 (0.9936 %) | 0 |
| capability_session_binding | 500 | 1814/1814 | 0/400 (0.7461 %) | 0/1414 | 0/400 (0.7461 %) | 0 |
| capability_tool_scope | 500 | 1553/1553 | 0/358 (0.8333 %) | 0/1124 | 0/358 (0.8333 %) | 0 |
| concurrent_authority_isolation | 500 | 2052/2052 | 0/501 (0.5962 %) | 0/1694 | 0/287 (1.0384 %) | 0 |
| cross_session_isolation | 500 | 1832/1832 | 0/334 (0.8929 %) | 0/998 | 0/334 (0.8929 %) | 0 |
| replay_duplicate_request | 500 | 2397/2397 | 0/500 (0.5974 %) | 0/1896 | 0/358 (0.8333 %) | 0 |
| result_gating | 500 | 2149/2149 | 0/334 (0.8929 %) | 0/1648 | 0/251 (1.1864 %) | 0 |
| timestamp_freshness | 500 | 1632/1632 | 0/314 (0.9495 %) | 0/1318 | 0/314 (0.9495 %) | 0 |
| **total** | 8500 | 34640/34640 | 0/6567 (0.0456 %) | 0/23622 | 0/5845 (0.0512 %) | 0 |

Escalation: expected ASK 5378, ASK→ASK 5378, ASK→ALLOW 0, ASK→DENY 0, ALLOW→ASK 0, DENY→ASK 0.
Invariants (runtime): duplicate_executions 0, unexpected_executions 0, cross_request_executions 0, cross_session_executions 0, unexpected_deliveries 0, permit_reuses_accepted 0.
Family macro-average exact match: 100 %.

## Component boundary (direct component calls; different evidence level)

| Family | Cases | Exact match | False allow (k/n, 95% UB) | False deny (k/n) | Bypass (k/n, 95% UB) | Inv. violations |
|---|---:|---:|---|---|---|---:|
| approval_verifier_request_binding | 500 | 500/500 | 0/400 (0.7461 %) | 0/100 | 0/400 (0.7461 %) | 0 |
| approval_verifier_session_binding | 500 | 500/500 | 0/400 (0.7461 %) | 0/100 | 0/400 (0.7461 %) | 0 |
| execution_permit_single_use | 500 | 500/500 | 0/429 (0.6959 %) | 0/71 | 0/429 (0.6959 %) | 0 |
| **total** | 1500 | 1500/1500 | 0/1229 (0.2435 %) | 0/271 | 0/1229 (0.2435 %) | 0 |

Invariants (component): duplicate_executions 0, unexpected_executions 0, cross_request_executions 0, cross_session_executions 0, unexpected_deliveries 0, permit_reuses_accepted 0.

## Mutation sensitivity

Runtime: 14/14 killed. Component: 3/3 killed. (Reported per boundary; not combined.)

| Mutant | Boundary | Status | Witnesses / baseline-valid candidates / candidates | Example witness cases |
|---|---|---|---|---|
| M01-capability-agent-binding-bypass | runtime | killed | 287 / 287 / 358 | case-000001, case-000002, case-000003 |
| M02-capability-session-binding-bypass | runtime | killed | 384 / 484 / 484 | case-000501, case-000502, case-000503 |
| M03-capability-tool-scope-bypass | runtime | killed | 216 / 216 / 287 | case-001001, case-001002, case-001003 |
| M04-capability-expiry-bypass | runtime | killed | 334 / 334 / 334 | case-001501, case-001502, case-001503 |
| M05-capability-not-yet-valid-bypass | runtime | killed | 300 / 300 / 300 | case-002001, case-002002, case-002003 |
| M06-approval-tool-binding-bypass | runtime | killed | 334 / 334 / 417 | case-003501, case-003502, case-003503 |
| M07-approval-approver-binding-bypass | runtime | killed | 334 / 334 / 417 | case-004001, case-004002, case-004003 |
| M08-approval-pending-timeout-bypass | runtime | killed | 200 / 200 / 200 | case-004501, case-004502, case-004503 |
| M09-approval-issued-before-ask-bypass | runtime | killed | 300 / 300 / 300 | case-005001, case-005002, case-005003 |
| M10-approval-future-skew-bypass | runtime | killed | 300 / 300 / 300 | case-005501, case-005502, case-005503 |
| M11-replay-duplicate-bypass | runtime | killed | 441 / 441 / 441 | case-006001, case-006002, case-006003 |
| M12-timestamp-freshness-bypass | runtime | killed | 314 / 314 / 314 | case-006501, case-006502, case-006503 |
| M13-result-withhold-bypass | runtime | killed | 251 / 251 / 251 | case-008001, case-008002, case-008003 |
| M14-approval-consumption-deferred-past-async-boundary | runtime | killed | 216 / 216 / 216 | case-007501, case-007502, case-007503 |
| M15-verifier-request-binding-bypass | component | killed | 200 / 200 / 400 | case-008501, case-008502, case-008503 |
| M16-verifier-session-binding-bypass | component | killed | 200 / 300 / 400 | case-009001, case-009002, case-009003 |
| M17-execution-permit-reuse-bypass | component | killed | 287 / 287 / 287 | case-009501, case-009502, case-009503 |

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
