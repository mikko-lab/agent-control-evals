# Adapter protocol v1

The adapter boundary is a **process boundary**. The harness starts the adapter process and exchanges **JSON Lines** over stdin and stdout: one JSON object per line, UTF-8 and LF. The adapter process may stay alive for many cases, but it must process them strictly one at a time and in order. Diagnostics go to stderr only.

Schemas: [`schemas/adapter-protocol-v1.schema.json`](../schemas/adapter-protocol-v1.schema.json) and [`schemas/case.schema.json`](../schemas/case.schema.json). An adapter can be written in any language.

## Messages

Harness to adapter:

```json
{"type":"hello","protocol_version":1}
{"type":"case","protocol_version":1,"case":{"case_schema_version":"0.1.0","case_id":"case-000001","family":"…","variant":"…","evaluation_boundary":"runtime","scenario":{…}}}
{"type":"shutdown","protocol_version":1}
```

The `case` object never contains `expected`; the oracle's expectation stays inside the harness.

Adapter to harness, with exactly one line per `hello` and per `case`:

```json
{"type":"hello","protocol_version":1,"adapter":"acs-guardrail-demo-adapter","adapter_version":"0.1.0",
 "sut":{"name":"acs-guardrail-demo","commit":"403d315…","version":"0.4.0","worktree_clean":true}}

{"type":"case_result","case_id":"case-000001","protocol_version":1,"evaluation_boundary":"runtime",
 "status":"ok",
 "observations":{"assertions":[{"step":0,"stage":"request","outcome":"DENY","reason_class":"CAPABILITY_AGENT_MISMATCH",
                                 "sut_reason_code":"capability_agent_mismatch","enforcement_stage":"capability"}],
                 "executions":{"s1/q1":0},"unattributed_executions":0},
 "raw_sut_evidence":{…}}
```

`status` is `ok` or `adapter_error`. An `adapter_error` carries `error.message` and `observations: null`.

## Error semantics

| Situation | Classification | Effect |
|---|---|---|
| Adapter returns `status: "adapter_error"` | adapter error | The case is not evaluated and enters no metric. The run is invalid (exit 2). Everything observed before the error, including tool-double executions, stays in `raw_sut_evidence.partial` and is counted in the error record (`observed_executions`). |
| The SUT's authority decision and the observed effect disagree | **SUT finding**, not an error (adapter ≥ 0.3.0) | The normalised outcome follows the effect, and the SUT's decision is kept in `sut_decision`. The decision point's `effect_record` carries both, and the harness classifies it as `unauthorized_execution`, `unauthorized_delivery` or `missing_expected_effect` (see `docs/evaluation-spec.md` §12). |
| An effect is observed but no SUT authority decision is attributable to the call | **observability finding**, not an error (adapter ≥ 0.4.0) | The decision is `DECISION_NOT_OBSERVED`; the observed effect is kept. The harness reports `decision_not_observed` and leaves the point out of the clean integrity denominators. |
| Invalid JSON, wrong `case_id`, unknown stage, outcome or reason class, missing field | protocol error | The run stops and is invalid. |
| Adapter exits, hangs past the per-case timeout, or answers unsolicited | protocol or harness error | The run stops and is invalid. |
| `hello` with the wrong protocol version, SUT commit or worktree state | harness error | No case is sent. |
| Real SUT disagrees with the oracle | **finding** | Reported as a finding (exit 1). It is never relabelled as an error. |

Adapter and harness errors **never** become `DENY`, `REJECT` or `WITHHOLD`, and never improve a safety metric. When the ACS adapter observes neither a SUT authority decision nor any effect for a call (for example, a `TypeError` from a mutant before anything ran), it raises `AdapterError`; it never maps such a call to DENY.

## ACS adapter (v0.4.0)

`node dist/src/adapter/acs/main.js --sut-build <build> --sut-checkout <checkout>`

- **Runtime cases** call only `GuardedExecutor.process`, `GuardedExecutor.resolveApproval` and `GuardedExecutor.clearSession`. Each case gets fresh stateful SUT components (replay guard, correlation store, audit collector, executor). The schema validator is stateless and is shared.
- **Component cases** call `ApprovalGrantVerifier.verifyV2` directly with a trusted context, or `ExecutionGate.mintPermit` and `execute` with a harness-held authority symbol.
- **Materialisation:** labels become deterministic version-4-shaped UUIDs derived from SHA-256 of the case id, namespace and label. Request envelopes are signed with the SUT's `SignatureService` (HMAC-SHA256). Capabilities and approval grants are Ed25519-signed with harness keys generated per adapter process. A "tampered" value is rewritten after signing.
- **Authority decisions come only from SUT authority evidence (adapter 0.4.0).** Every decision point (request attempt, approval step per target request, permit attempt) yields an `effect_record`. Its decision fields are:
  - `sut_decisions` with a parallel `decision_sources` (`audit_event`, `sut_exception`, `none`):
    - request ALLOW / ASK / DENY by the Guardian: the call's own `guardian_decision` audit event;
    - pre-Guardian DENY: the classified rejection, backed by its `capability_rejected`, `replay_rejected` or `timestamp_rejected` audit event, or, for request signature and schema failures (the SUT writes no audit event for them), the exception alone (`sut_exception`);
    - approval EXECUTE: the call's own `human_approval` audit event; REJECT: `human_rejection`, `approval_verification_failed`, `approval_expired`, or the freshness exceptions (`sut_exception`);
    - permit EXECUTE: the ExecutionGate's `tool_execution_started` audit event; permit REJECT: the gate exception (`sut_exception`);
    - otherwise `DECISION_NOT_OBSERVED`. A return status (`executed`, `pending`), a returned value, or an exception class alone never yields ALLOW or EXECUTE.
  - `result_control_decisions` (`DELIVER` / `WITHHOLD`) and `result_control_state` (`observed`, `not_observed`, `ambiguous`, `not_applicable`): only `result_guardian_decision` audit events attributed to the call. `exit_status` is never a decision source; it stays in `sut_reports` as raw evidence.
  - Audit events are attributed by **window**, never by a search over the whole case audit: a call that runs alone owns the events appended during the call; for concurrent calls, request and approval decisions come from the events written by the call's synchronous prefix (before its first `await`), and Result Guardian events are linked through the SUT's own signed result request (`request_id_ref`), observed pass-through at the harness-owned `SignatureService` instance. Mixed Result Guardian decisions among concurrent attempts on one request id are `ambiguous`.
  - `sut_reports`: what the SUT returned or threw (status, `exit_status`, exception). Evidence only.
- **Effects come only from observation channels, each with an explicit state.** `execution_observation` and `delivery_observation` have a `state` (`observed`, `not_observed`, `ambiguous`, `unavailable`) and a `source`:
  - `harness_tool_trace`: harness tool doubles, attributed by the per-attempt trace argument. Executions without a trace are recorded as an `unattributed`, `ambiguous` record.
  - `sut_counter`: the SUT's fallback-tool counter for tools outside the harness registry. Attributable only when a single call can have caused the delta; otherwise `ambiguous`.
  - `return_value_scan`: the exact raw tool output recorded by the doubles, found by key-order-independent structural search anywhere in the value the call returned (also inside wrappers). Thrown exceptions are not scanned. Partial, transformed or semantic leaks are not detected.
  - `none`: no channel (`unavailable`), e.g. the component execution gate has no delivery channel.

  Effects are never derived from decisions, and authority decisions are never derived from effects. The normalised outcomes below are effect-based by design and are a separate field from the authority decision.
- **Normalised outcomes follow the effect.** Request ALLOW means this attempt's execution was observed. A result is DELIVER iff a raw output was observed in what the call returned. Approval outcomes are reconciled per target request against observed executions: surplus executions turn REJECT or not-observed decisions into EXECUTE, and authorised executions without an effect become REJECT, preferring ones that failed on the result path. Whenever the effect overrides the decision or no decision was observed, the assertion carries `sut_decision` and `decision_effect_mismatch: true`.
- **An observed execution or delivery is never turned into an `AdapterError`.** This holds whether the SUT threw, reported DENY, ASK or REJECT, no authority decision was observed, or the two simply disagree. `AdapterError` remains only where the adapter cannot produce a reliable observation:
  - no SUT authority decision and no observed effect for a call;
  - an adapter bug or invalid scenario operation (including an empty capability queue);
  - a protocol failure.

  In the first two cases everything observed so far (`effect_records` included) is kept in `raw_sut_evidence.partial`.

### Clock model

Each runtime case uses a **frozen** evaluation clock: the wall time captured at case start plus scenario offsets, advanced only by `advance_clock`. Boundary cases such as "expires exactly now" and "±300 000 ms" are therefore exact and deterministic.

The pinned SUT stamps its internally generated result request with the wall clock (`new Date()`) but checks it against the injected clock. Positive scenarios therefore keep clock advances at or below 240 000 ms (`MAX_POSITIVE_CLOCK_ADVANCE_MS`), well inside the 300 000 ms request window. This is an adapter/test-setup constraint, not a SUT finding: in production both clocks are the same.

### Harness-owned tool test doubles

To produce controlled, corpus-defined tool outputs (result gating) and to attribute every execution to a scenario request, the adapter temporarily registers harness-owned doubles for `read_record` and `update_record` in the pinned SUT process's `tools` registry. This is part of the adapter, not an ACS feature.

- The doubles are defined in this repository (`src/adapter/acs/tool-doubles.ts`). They make no decisions and contain no oracle logic: they return a deep copy of the corpus value and record that they ran.
- The registry is snapshotted before each case and restored exactly afterwards, and the restore is verified.
- Only one case may hold the registry at a time. A concurrent install is refused, because interleaving could restore a foreign snapshot and leak doubles.
- Tested in `test/tool-doubles.test.ts` and `test/sut-integration.test.ts`: originals are restored, outputs and logs do not leak between cases, and concurrent installs are refused.
- Executions through ACS's fallback `unknownToolMock` are counted as `unattributed_executions`, which must be 0.
