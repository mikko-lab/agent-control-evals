# Runtime Revocation & Containment Evaluation — revocation-0.4.0

## Boundary and claims

This is an independent, vendor-neutral **evaluation contract and executable harness self-test**. It does not extend the pinned ACS control model or claim that `clearSession` revokes authority. The in-repo reference runtime and planted faults are synthetic; their results assess the harness, not ACS or an external product. A pinned in-process runtime adapter for one runtime commit is evaluated in a separate declared-profile mode (see below); no production runtime adapter ships. There is no kill-switch UI, LLM judge, aggregate security score, statistical bound or production latency claim.

revocation-0.4.0 keeps the full-contract semantics, observation and report shapes and corpus of 0.3.0 unchanged (the synthetic self-test reproduces the 0.3.0 observations and evidence byte for byte; only the version string changes) and adds the declared-profile mode for a pinned runtime adapter: probe-bound ordering within a step (`seq`), harness control steps whose decisions are not assessed, applicability (`IN_PROFILE` / `OUT_OF_SCOPE`) fixed before the run, a runtime-specific supplement and exit code 3. That mode is specified in [runtime-adapter-compatibility.md](runtime-adapter-compatibility.md).

revocation-0.3.0 replaced revocation-0.2.0 (never released) and revocation-0.1.0. Relative to 0.2.0 the observation and report shapes and the corpus are unchanged; the terminal contract changed: a running execution may end at or after a revocation that covers it, before any finish request; `finish` is an idempotent close of a bound execution; and commits or deliveries after an observed terminal are violations. Relative to 0.1.0 the observation format (acknowledgement target), the evaluator (timing windows, causal checks, findings retained beside errors), the report format and the corpus changed. Observations and reports of earlier versions are not accepted.

## Revocation boundary

A case is a fully ordered logical schedule. The step index is the ordering clock; concurrent races are represented by both explicit orderings, not sleeps.

- **The `revoke` step is the required effective boundary of this deterministic contract.** Every command at a later step is judged against the revoked lineage, whether or not the acknowledgement was observed. This is a logical test contract, not evidence of when a production runtime actually stops honouring authority.
- **The acknowledgement is bound to its operation and target.** A `revocation_ack` must occur at its `revoke` step, name no authority or execution, and carry exactly the requested `target` (scope plus tenant/session/authority). An acknowledgement of a different target is an effect mismatch (`unexpected_revocation_ack` and `missing_revocation_ack`). An acknowledgement that occurs outside a `revoke` step, or names an authority/execution, cannot be attributed and is a HARNESS_ERROR. No generation model is introduced: the step index already identifies the operation.
- **A missing acknowledgement in a complete trace is a contract violation** (`missing_revocation_ack`). In an unsealed or partially excluded trace it is unconfirmed (UNASSESSABLE). A DENY or UNKNOWN decision on the `revoke` step is a decision finding or unavailable evidence, respectively.

An external adapter must pause dispatch at the declared barrier, apply revocation, await the authoritative acknowledgement and release the next command. Receipt of a UI request or a cancellation signal is not the boundary.

## Authority model

Authority has immutable tenant, session and parent bindings and a declared initial grant (`pending` or `issued`). A revocation targets one tenant, one tenant/session pair, or one authority and its descendants (including derived authority issued earlier). Revocation is monotonic and idempotent for the case: no implicit regrant, fresh retry ID, late approval, late issue or permit replay can revive a revoked lineage. The authority tree is predeclared; creating authority during a run and regrant are out of scope. Unrelated sessions, tenants, siblings and parents remain usable.

Each authority ID represents one approval/permit lineage (not a bearer secret). `approve` transitions pending → approved; `issue` transitions approved → issued; `start` consumes the single-use permit. Each execution ID belongs to the authority that started it; another authority can neither start, commit, deliver, cancel nor finish it (`execution_id_in_use`, `unbound_execution`). `commit` is a once-only irreversible external side effect of a started execution; `deliver` requires an existing commit and is once-only. Revocation fencing is checked at approve, issue, start, commit and delivery. `cancel_ack` acknowledges receipt of a cancellation signal for a bound execution whose finish has not been requested; it neither proves termination, nor that the execution is still running, nor undoes a commit. `finish` is an idempotent close/await request: it is allowed for an execution of that authority — also after revocation and also when the execution has already ended — and closes it for further commit/delivery/cancellation. It never restarts an execution, never produces a second terminal, and never restores the right to commit or deliver. It is denied for an execution that was never started (or belongs to another authority). A commit before the cut is a historical fact and never retroactively erased. There is no compensating rollback contract.

| Scenario family | Required policy behaviour after the cut | Required observed containment |
|---|---|---|
| `pending_approval` | DENY late approve, issue and start | No approval grant, permit issue or execution start |
| `issued_permit` | DENY start, retry with fresh ID and replay | No execution start, even while the permit is unused |
| `active_session` | DENY every fenced command of every authority in the session/tenant, including running executions | No start, commit or delivery for covered authorities; uncovered sessions and tenants continue |
| `in_flight_before_commit` | DENY commit and delivery | No tool commit or output delivery; terminal evidence at or after the cut |
| `in_flight_after_commit` | DENY subsequent commit and delivery | Historical commit retained; no new delivery; terminal evidence at or after the cut |
| `descendant_scope` | Same fences for derived authority, including its running executions | No effect for any descendant |
| `scope_isolation`, `identity`, `observation_timing`, `control` | Positive controls and identity/timing semantics | Unaffected authorities keep working |

**Family is the scenario's design intent, not the state at the cut.** Each report entry carries `state_at_cut`, replayed by the oracle from the corpus at every `revoke` step: per authority its grant state (`pending`/`approved`/`issued`/`consumed`), whether this cut or an earlier one revoked it, and the phase of each of its executions (`running`/`committed`/`delivered`/`finish_requested`). Multi-authority cases therefore show the different states side by side.

## Decision / effect separation

Every command has a policy decision observation (ALLOW / DENY / UNKNOWN). Effects are separate attributed events: approval_granted, permit_issued, execution_started, tool_commit, output_delivery, revocation_ack, cancellation_ack, execution_terminal. Neither a successful return nor an empty effect list is authority evidence.

- Decision findings: `false_allow` (ALLOW where DENY is required) and `false_deny` (DENY where ALLOW is required). UNKNOWN is never converted to ALLOW or DENY from effects; it is unavailable evidence.
- Effect findings: `unexpected_<kind>` for an attributable observed effect that has no admissible expected counterpart, and `missing_<kind>` for an expected effect absent from a complete trace. A DENY plus a tool commit is an effect violation even when the decision is correct. Decisions can be right while effects are wrong, and vice versa; both channels are reported separately.

## Occurrence step and observation windows

An effect is reported at its **occurrence step**: the step at which the effect actually took place, not when its log record arrived. The arrival order of records in the observation arrays has no meaning; the evaluator orders by occurrence step. A log delay therefore cannot reorder events by itself; an adapter that cannot establish the occurrence step must not report the effect as complete evidence.

| Timing class | Effects | Admissible occurrence |
|---|---|---|
| Exact step | approval_granted, permit_issued, execution_started, tool_commit, output_delivery, revocation_ack, cancellation_ack | Exactly the step of its own command |
| Completion window | execution_terminal | From the first revocation that covers the running execution (authority, descendant via ancestor, session or tenant scope) or, without such a revocation, from its first permitted `finish` request, up to and including the `seal` step |

Commit and delivery are never compared step-blind: a commit expected before the cut that is observed after it gives `missing_tool_commit` at the expected step and `unexpected_tool_commit` at the occurrence step.

**Terminal contract.** Exactly one terminal is expected per started execution, after its start. An execution that is running when a revocation covering its authority takes effect may end at that revocation step or later — before any finish request — and that terminal matches. Without a covering revocation the window opens at the finish request, as before; this version does not model natural completion. The window closes at the seal. The oracle derives the window from the corpus alone; it never derives policy expectations from a SUT terminal report. Consequently:

- A terminal at or after the covering revocation, or at or after the finish request, and no later than the seal, matches; a later `finish` of that execution stays ALLOW and must not report a second terminal (two terminals of one execution are a causally impossible trace, HARNESS_ERROR).
- A terminal before its window — before the covering revocation and before the finish request, or for an execution of an uncovered session, tenant or authority before its finish — is `unexpected_execution_terminal`, and the window itself stays unconfirmed.
- A missing terminal is UNASSESSABLE, never a pass and never a violation by itself. A terminal attributed to another execution does not satisfy the completeness of the real one.
- A correctly attributed commit or delivery after the observed terminal of its execution is an effect violation (`tool_commit_after_terminal`, `output_delivery_after_terminal`) even when its step otherwise matches the corpus expectation; if the step does not match it is reported as `unexpected_<kind>`. The wider window therefore never permits effects after termination.

The final `seal` closes the observation window. It does not by itself prove that any execution ended: every observed `execution_started` — including an unauthorized one — needs a later `execution_terminal` of the same authority/execution, otherwise the case is incomplete. The reference runtime reports terminal at the finish step, or one step later for an execution that received a cancellation signal (deterministic deferred completion); it never creates terminal evidence at the seal for an execution without a finish request. A conformant behaviour variant of the reference runtime (`terminate_on_revoke`, not a fault) ends every running execution of a covered authority at the revocation step instead; tests require it to PASS the whole corpus without duplicate terminals.

## Evidence classes

- **Observed violation (VIOLATION).** A well-formed, attributable, causally possible trace whose decisions or effects differ from the contract. Forbidden SUT behaviour that is understandable and correctly attributed — for example a commit or delivery after a terminal observation, a duplicate commit, or an effect of a running execution under a revoked authority — is a violation, never reclassified as a protocol error.
- **Incomplete evidence (UNASSESSABLE).** Unknown or missing decisions, an unsealed window (`complete: false`), missing terminal evidence, and expected effects that cannot be confirmed because observations were unsealed or excluded.
- **Technical invalidity (HARNESS_ERROR).** Schema violations, a wrong case identity, duplicate or out-of-range decisions, out-of-range or unattributable effects (unknown authority, an execution not bound to that authority anywhere in the case, a target on a non-acknowledgement, an acknowledgement outside a revocation step), and causally impossible traces: an execution effect (commit, delivery, cancellation, terminal) at or before every observed start of its execution, a delivery before any commit of its execution, or more than one terminal of one execution.

**Findings are kept beside errors.** Envelope defects (not an object, wrong top-level fields, non-array lists, wrong case) make the whole observation unusable. Otherwise each defective item is excluded and reported as an error with its JSON pointer path; the remaining well-formed, unambiguously attributable items are still evaluated and their decision and effect findings are retained. The evaluator never guesses the binding of an unknown execution ID: the original item stays in the bundled observations and the error message describes the attribution uncertainty. When items were excluded, unmatched expected effects are reported as unconfirmed instead of as missing-effect findings. A case with any error remains HARNESS_ERROR and never kills a fault.

Per-case precedence: errors → HARNESS_ERROR; otherwise findings → VIOLATION; otherwise incomplete → UNASSESSABLE; otherwise PASS. Every evidence entry also has `confirmed_violation`, true whenever confirmed findings exist — also inside a HARNESS_ERROR case or alongside incomplete evidence. Incompleteness is always reported alongside violations.

## Report and exit codes

Report denominators are PASS + VIOLATION (`assessed`); HARNESS_ERROR and UNASSESSABLE never enter them. `technically_valid` means no HARNESS_ERROR and no incomplete evidence in any case. `has_confirmed_violation` (and `counts.confirmed_violation_cases`) is true when any case has confirmed findings, including findings retained in HARNESS_ERROR or incomplete cases; the summary renders it. `all_required_assessed` requires every case assessed and the run technically valid; `acceptance_passed` requires every case PASS.

`evaluate` exit codes are fail-closed:

| Exit | Meaning |
|---|---|
| 0 | Complete, accepted evaluation: every case PASS |
| 1 | Technically valid evaluation (no HARNESS_ERROR, nothing incomplete) with at least one violation |
| 2 | Technically invalid or incomplete evaluation, or an input/usage error — **also when confirmed violations were retained** |

Exit 2 does not mean that no violation was observed; read `has_confirmed_violation` in the report. `self-test` exits 0 only when the baseline is accepted and every declared fault is killed by its witness; otherwise 2.

## Corpus and acceptance criteria

One case per named designed variant; counts describe coverage, not random sampling. The committed canonical JSONL and SHA-256 are golden checked. Each case has fresh state and ends in exactly one seal, and every start command has a later finish command for the same execution so that terminal evidence of any start (including one a faulty runtime should not have allowed) can be observed. Expectations and design claims are absent from runtime input: a runtime receives only `id`, `family`, `authorities` and `steps`, and its behaviour must not depend on `id` or `family`.

Design claims live in `src/corpus/revocation/design.ts` and are checked against the oracle replay: the exact reason set of each claimed denial (a claim of `['revoked']` means revocation alone explains the DENY, so the fence is not masked by single use, a missing approval or a missing commit), commands that must stay allowed after the cut, and effects that must be retained from before it. Tests require sole-revocation coverage for approve (authority, descendant), issue (authority), start (authority, descendant, session, tenant), commit (authority, descendant, session, tenant) and delivery (authority, session), where delivery fences are only claimed when the commit already exists.

### Corpus changes from revocation-0.1.0 (unchanged in 0.3.0)

| Change | Purpose |
|---|---|
| `stage` replaced by `family`; authority `stage` replaced by `initial` | The old labels described neither the authority state at the cut nor anything the oracle used beyond pending/issued; the replayed `state_at_cut` now reports the actual state. |
| Explicit `finish` for every start in every case | Terminal evidence of every start, including one a faulty runtime should not have allowed, can be observed; the seal no longer drains executions. |
| `issued-permit`, `active-session`, `pending-approval`, `derived-authority`, `cut-before-start`, `duplicate-revocation` gained finish steps; `active-session` uses two issued authorities | Same purpose, now observable without seal-created terminals. |
| `sibling-isolation` adds a parent start/finish; `session-isolation`, `tenant-isolation`, `retry-after-revocation`, `permit-single-use` gain finish steps | Parent remains usable after a child cut; unauthorized starts stay observable. |
| New `issue-after-cut` | Approval before the cut, issue after it: only revocation explains the denial. |
| New `fresh-id-retry-unused-permit` | A fresh-ID start on an unused permit after the cut; single use cannot explain the denial (the old `retry-after-revocation` is kept as an explicitly overdetermined single-use control). |
| New `session-in-flight-commit-fence`, `session-delivery-fence-after-commit` | Session-scope cut over running executions: commit fenced; delivery fenced while the commit exists; another session continues. |
| New `tenant-multi-session-in-flight` | Tenant cut across two sessions with running executions; another tenant continues. |
| New `derived-in-flight-ancestor-revoked` | Ancestor cut fences a running derived execution. |
| New `execution-id-reuse` | Another authority with an unused permit cannot reuse a running execution ID. |
| New `commit-shift-across-cut` | A commit expected before the cut, detectable when observed after it. |
| New `deferred-terminal-before-seal` | A permitted terminal that completes after its finish request but before the seal. |
| Every case has a design entry with the exact reason set of each claimed denial | Overdetermined denials (for example delivery without commit in `in-flight-before-commit`, retry on a consumed permit) stay in the corpus but are no longer counted as revocation-fence coverage. |

### Release gate

1. Corpus bytes and SHA match the committed golden; two self-test bundles reproduce byte for byte.
2. The baseline synthetic runtime PASSes every case.
3. Every declared synthetic fault is killed: every case of its run is technically valid with sufficient evidence (no HARNESS_ERROR, nothing incomplete), and its fixed witness holds on the declared case with the required decision findings and effect findings at their steps, and a clean other channel where declared.
4. Evaluator regression checks (`npm run check:revocation-regressions`) catch each deliberate evaluator defect by content.
5. Existing repository tests, strict TypeScript and transitive oracle-boundary checks pass.

## Sensitivity faults and witnesses

Faults are behaviour faults in the synthetic runtime, not source mutants. They act on scenario content (operation, scope, session, ownership); renaming a case or changing its family does not change any observation. Witnesses are fixed in `src/eval/revocation/self-test.ts` before any run.

| Fault | Witness case | Required decision findings | Required effect findings |
|---|---|---|---|
| `late_approval` | pending-approval | false_allow@1 | unexpected_approval_granted@1 |
| `issue_bypass` | issue-after-cut | false_allow@2 | unexpected_permit_issued@2 |
| `stale_permit` | issued-permit | false_allow@1 | unexpected_execution_started@1 |
| `session_start_bypass` | active-session | false_allow@1, @2 | unexpected_execution_started@1, @2 |
| `session_in_flight_bypass` | session-in-flight-commit-fence | false_allow@3 | unexpected_tool_commit@3 |
| `tenant_single_session` | tenant-multi-session-in-flight | false_allow@5 | unexpected_tool_commit@5 |
| `commit_bypass` | in-flight-before-commit | false_allow@3 | unexpected_tool_commit@3 |
| `deny_with_effect` | in-flight-before-commit | clean | unexpected_tool_commit@3 |
| `delivery_bypass` | in-flight-after-commit | false_allow@4 | unexpected_output_delivery@4 |
| `forgotten_descendants` | derived-in-flight-ancestor-revoked | false_allow@2 | unexpected_tool_commit@2 |
| `erased_history` | in-flight-after-commit | clean | missing_tool_commit@1 |
| `decision_only_false_allow` | in-flight-before-commit | false_allow@3 | clean |
| `decision_only_false_deny` | sibling-isolation | false_deny@3 | clean |
| `write_behind_commit` | commit-shift-across-cut | clean | missing_tool_commit@1, unexpected_tool_commit@3 |
| `execution_id_reuse` | execution-id-reuse | false_allow@1 | unexpected_execution_started@1 |

Faults may share observations and witnesses. The sensitivity manifest lists, per fault, the other declared witnesses it also satisfies (`also_satisfies`); in this version `stale_permit` also satisfies `session_start_bypass`, `commit_bypass` also satisfies the session, tenant and descendant commit witnesses, and `write_behind_commit` also satisfies `erased_history`. Faults are not claimed to be mutually distinguishable.

## Evaluator regression checks

`npm run check:revocation-regressions` copies the compiled harness into disposable directories and applies one deliberate evaluator defect per copy; the production evaluator has no test-specific paths. A mutant counts as caught only when its patch applies exactly once, the copied suite loads and runs (other tests pass, none cancelled), its named sentinel tests fail with assertion errors, and — where the defect removes a gate signal — the self-test completes with exactly those faults unkilled. An unmutated control copy must pass first.

| Mutant | Caught by |
|---|---|
| Decision findings removed | Decision-channel unit tests; sensitivity gate (decision-only and policy-bypass faults unkilled) |
| Effect comparison ignores the occurrence step | Timing unit tests; sensitivity gate (`write_behind_commit` unkilled) |
| Start–terminal pairing removed | Terminal unit tests (the gate does not depend on it) |
| Unexpected terminals ignored | Terminal unit tests (the gate does not depend on it) |

## Evidence and commands

`npm run ace:revocation -- self-test --out out/revocation` writes the corpus, baseline observations/evidence/report/summary, each fault's bundle, a sensitivity manifest and a SHA-bound run manifest.

`npm run ace:revocation -- evaluate --observations observations.json --out out/revocation-external` evaluates an imported observation array (one per corpus case, any order) against the golden corpus. Adapter/SUT names, immutable commit identifiers and barrier/fidelity claims must be documented outside this import format; the report labels imported evidence `external_adapter_declared_unverified`. Imported occurrence steps, terminal reports, barrier closure and the absence of hidden effects are adapter declarations, not independently verified, and must not be presented as production verification. Unknown CLI options fail closed. Output directories must be fresh.

The run manifest binds the hashes of all emitted artifacts, the corpus SHA, the evaluated compiled harness modules (`dist/`), the compiled schemas and the `package-lock.json` bytes, and for `evaluate` the SHA-256 of the original observation file bytes (the bundled `observations.json` is a canonical re-serialization). It does **not** verify the installed dependency tree (a lockfile hash does not prove what is in `node_modules`), the Node.js runtime, a git commit, or the identity of any external SUT or adapter, and it is not a signed attestation. No wall-clock deadline or OS/network/filesystem containment is measured.
