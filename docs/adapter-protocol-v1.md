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
| Adapter returns `status: "adapter_error"` | adapter error | The case is not evaluated and enters no metric. The run is invalid (exit 2). |
| Invalid JSON, wrong `case_id`, unknown stage, outcome or reason class, missing field | protocol error | The run stops and is invalid. |
| Adapter exits, hangs past the per-case timeout, or answers unsolicited | protocol or harness error | The run stops and is invalid. |
| `hello` with the wrong protocol version, SUT commit or worktree state | harness error | No case is sent. |
| Real SUT disagrees with the oracle | **finding** | Reported as a finding (exit 1). It is never relabelled as an error. |

Adapter and harness errors **never** become `DENY`, `REJECT` or `WITHHOLD`, and never improve a safety metric. The ACS adapter raises `AdapterError` for any SUT exception it cannot classify from a fixed table. For example, a `TypeError` from a mutant is an adapter error, not a DENY.

## ACS adapter (v0.1.0)

`node dist/src/adapter/acs/main.js --sut-build <build> --sut-checkout <checkout>`

- **Runtime cases** call only `GuardedExecutor.process`, `GuardedExecutor.resolveApproval` and `GuardedExecutor.clearSession`. Each case gets fresh stateful SUT components (replay guard, correlation store, audit collector, executor). The schema validator is stateless and is shared.
- **Component cases** call `ApprovalGrantVerifier.verifyV2` directly with a trusted context, or `ExecutionGate.mintPermit` and `execute` with a harness-held authority symbol.
- **Materialisation:** labels become deterministic version-4-shaped UUIDs derived from SHA-256 of the case id, namespace and label. Request envelopes are signed with the SUT's `SignatureService` (HMAC-SHA256). Capabilities and approval grants are Ed25519-signed with harness keys generated per adapter process. A "tampered" value is rewritten after signing.
- **Normalisation:** an execution is observed through the harness tool doubles, not inferred from return values. A rejection that happens after the tool ran (correlation failure or result-path replay) is therefore EXECUTE or ALLOW plus a result WITHHOLD, never a REJECT or DENY.

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
