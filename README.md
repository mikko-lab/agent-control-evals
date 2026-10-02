# agent-control-evals

A deterministic, reproducible evaluation harness for agent runtime control systems.

v0.1 has exactly one System Under Test (SUT):
[`mikko-lab/acs-guardrail-demo`](https://github.com/mikko-lab/acs-guardrail-demo) version `0.4.0` at commit
`403d31593a0d57187df3f5e1ef3df6127baaefb9` (see [`sut.lock.json`](sut.lock.json)).

> The generator, oracle specification and mutation set are human-authored and may share conceptual blind spots. The evaluation demonstrates conformance to the declared evaluation specification, not absolute real-world safety.

This harness does **not** show that the SUT is secure, safe, certified, proven or production-ready. Results are reported in this form:

> At SUT commit C, harness version H, corpus version V and control families F, X/Y oracle mismatches were observed. The harness detected Z/W deliberately planted faults.

The exact sentences come from the report data (`summary.md` is rendered from `report.json`). No number in the documentation is copied by hand.

## What is measured, and how

```text
corpus validity → oracle independence → adapter validity → mutation reachability
→ mutation sensitivity → baseline SUT results → statistical bounds
```

| Piece | Where | What it guarantees |
|---|---|---|
| Deterministic corpus | `src/corpus/` | The same generator version, seed, allocation and case count give byte-identical canonical JSON Lines. The smoke corpus SHA is golden-checked (`corpus/smoke.sha256`). |
| Oracle | `src/oracle/expected.ts` | Expected behaviour is derived from the scenario structure and the declared spec only, before any SUT call. A static transitive import check (`ace oracle-boundary`) fails if the oracle or generator can reach adapter, SUT, evaluation or filesystem code. |
| Adapter protocol v1 | `docs/adapter-protocol-v1.md`, `schemas/` | Process boundary with JSON Lines over stdin/stdout. Expectations are never sent to the adapter. Malformed or late output is a protocol error, never a safety outcome. |
| ACS adapter | `src/adapter/acs/` | Integration with the pinned ACS: the `GuardedExecutor` public API for runtime cases, and `ApprovalGrantVerifier` / `ExecutionGate` for component cases. It contains no oracle logic. |
| Mutation set | `mutations/` | 17 patches against the pinned SHA: 14 runtime and 3 component. Each patch has a documented reachability path, is applied in a fresh disposable checkout, and is killed only by a technically valid witness case. |
| Report | `schemas/report.schema.json` | Versioned JSON. Runtime and component metrics live in separate trees, and there is no aggregate security score. |

### Evaluation boundaries

Every control has an `evaluation_boundary` of `runtime`, `component` or `N/A`:

- **runtime**: the control is exercised only through the pinned public runtime path (`GuardedExecutor.process`, `resolveApproval`, `clearSession`).
- **component**: the control exists in ACS but cannot purposefully be provoked through `GuardedExecutor`. It is tested directly on the component: the `ApprovalGrantVerifier` request/session binding and `ExecutionGate` permit single use. See [`docs/mutation-reachability.md`](docs/mutation-reachability.md) for why.
- **N/A**: the control is not modelled by the pinned SUT or is out of scope for v0.1 (tenant isolation, production latency/throughput). N/A is never a pass, a zero, a percentage, part of a denominator or part of a mutation score.

Runtime and component results are **different levels of evidence**. They are never combined into one number. For example, "an approval issued for another request is rejected at runtime" (runtime family `approval_wrong_request_runtime`) and "the `ApprovalGrantVerifier` request-binding mutant is killed" (component mutant M15) are separate statements about separate things.

See [`docs/evaluation-spec.md`](docs/evaluation-spec.md) for the control matrix, outcome semantics, reason taxonomy and the declared policy parameters.

## Claims discipline

**What the harness measures.** Whether the pinned SUT behaves as a declared, deterministic evaluation specification requires, on synthetic corpus data.

**Mutation sensitivity.** The harness detected the defined, deliberately planted faults in the mutation set. This does not show that all realistic faults would be detected.

**Zero failures.** This means *zero observed failures in this evaluated corpus*. It does not mean zero failure probability.

**Confidence bounds.** Confidence bounds are conditional on the declared synthetic corpus sampling model. They are not estimates of the real-world probability that the system will fail in production. Since report schema 0.2.0, bounds are computed only on scenario proportions. Assertion counts are descriptive, and breadth is the number of designed variants, not the number of cases (`docs/evaluation-spec.md` §10–11).

**Oracle.** The oracle is a human-written specification, not an independent source of security truth. Its policy parameters were written down from the pinned SUT's documented demo configuration, so a misunderstanding shared by both authors would not be detected.

**Evaluation boundary.** Runtime and component results are different levels of evidence and are never presented as one security score.

The full list of limitations is emitted verbatim into every report (`src/report/limitations.ts`).

## Quick start

Requires Node.js 22 or 24, git, and network access to GitHub and the npm registry (to clone the SUT and run `npm ci` in it).

```sh
npm ci
npm run build
npm test                                   # unit + contract tests (SUT-dependent ones skip without a SUT env)

node dist/src/cli.js oracle-boundary       # static oracle dependency check
node dist/src/cli.js sut-verify --run-sut-tests   # read-only clone, pinned SHA, clean tree, SUT's own npm run verify
node dist/src/cli.js golden                # smoke corpus determinism + golden SHA
node dist/src/cli.js reachability          # static mutation reachability validation

# smoke evaluation, both boundaries, all mutants, determinism re-run
node dist/src/cli.js evaluate --profile smoke --boundary all --mutations all --check-observation-determinism --out out/smoke

# full ~10 000-case benchmark (manual; also available as the full-benchmark workflow_dispatch)
node dist/src/cli.js evaluate --profile full --boundary all --mutations all --check-observation-determinism --run-sut-tests --out out/full
```

Every `evaluate` run writes `corpus.jsonl`, `corpus-manifest.json`, `report.json` and `summary.md` into the output directory.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Valid run, no baseline findings, every executed gate passed |
| 1 | Valid run, but the real SUT showed oracle mismatches (findings, reported as such and never relabelled as harness errors) |
| 2 | Harness invalid: corpus, oracle, adapter, protocol, SUT SHA or report problem. Adapter and harness errors never become DENY/REJECT/WITHHOLD |
| 3 | Mutation gate failed: a surviving or invalid mutant, or a reachability problem |

## Reports

Generated reports for the v0.1 review candidate are committed under [`reports/v0.1/`](reports/v0.1/): `smoke/` (the 500-case CI profile) and `full/` (the ~10 000-case benchmark, run locally). Each directory has `report.json`, the `summary.md` rendered from it, and `corpus-manifest.json`. Each report records the `sut_commit`, `harness_commit` and `corpus_sha256` it was produced with. See [`docs/review-v0.1.md`](docs/review-v0.1.md) for the self-review, the deviations from the work order and the open risks.

## SUT handling

ACS is never installed as an npm or git dependency (it is a `private` package without a stable library API). For every run and every mutant the harness:

1. clones or fetches the public repository into a local bare mirror under `.work/` (read-only; nothing is pushed);
2. creates a fresh detached checkout of exactly `403d315…`, with its remote removed;
3. verifies HEAD, a clean worktree and `package.json` version `0.4.0`, and fails closed otherwise;
4. runs `npm ci` and verifies that the tracked tree is still clean;
5. compiles `src/` with a harness-owned tsconfig into a separate build directory, leaving the SUT tree untouched;
6. for a mutant only: applies exactly one patch, verifies that only the declared target file changed, and never chains mutants.

No exports are added to ACS. The adapter registers harness-owned tool test doubles in the SUT process's `tools` registry for the duration of one case, restores the registry afterwards, and refuses interleaved installs (tested).

## Repository layout

```text
sut.lock.json            pinned SUT
src/spec/                control matrix, families, outcomes, reason taxonomy, declared policy
src/corpus/              case model, variant builders, deterministic stratified generator
src/oracle/              oracle (spec-only) + static dependency-boundary checker
src/adapter/             protocol v1 + ACS adapter (runtime, component, tool doubles)
src/eval/                adapter client, comparator, runner, metrics, statistics
src/sut/                 disposable checkout, build, environments
src/mutation/            manifest, reachability validation, mutation runner
src/report/              manifest, report builder, schema validation, summary renderer
schemas/                 case, adapter protocol v1, report (JSON Schema 2020-12)
mutations/               17 patches + manifest.json (reachability paths, patch SHA-256)
corpus/                  golden smoke corpus + SHA-256
docs/                    evaluation spec, adapter protocol, mutation reachability, review notes
```

## Not in v0.1

There is no OpenShell adapter or other SUT, no LLM oracle and no LLM case generation. There is also no tenant support, latency/SLA benchmark, web UI, dashboard, SIEM integration, certification framework, change to ACS or new ACS runtime control.
