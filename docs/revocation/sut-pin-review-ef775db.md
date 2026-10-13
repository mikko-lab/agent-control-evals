# SUT pin review — revocation track, `acs-guardrail-demo` v0.6.0 @ `ef775db`

Status: **review record of the eval integration of the approval–permit lifecycle (G3/G4).** It records:
- what the new pin binds and the baseline;
- the evidence kinds;
- the re-verification of every existing mutant under permit mode;
- the deviations from the approved [plan](approval-permit-lifecycle-plan.md) and the open risks.

The adapter rules are in [§14 of the compatibility specification](runtime-adapter-compatibility.md#14-revision-for-the-v060-pin-approvalpermit-lifecycle-g3g4).

## 1. Pin

The identifiers were checked against the runtime's remote before the lock was changed:
- `main` and `v0.6.0^{}` are `ef775db`;
- the tag object `c83cd669…` is of type `tag`;
- the tree, `package.json` version, package-lock SHA-256 and `MAX_CHAIN_LENGTH` are as below.

| Binding | Earlier pin (`profiles/revocation/history/sut.revocation.a9deab6.lock.json`) | New pin (`sut.revocation.lock.json`) |
|---|---|---|
| Commit | `a9deab6709d6ca2ba8f3988693b50fa807eadc0c` | `ef775dbff6c5691b4b2d44611b22eb33c431f451` (merge of mikko-lab/acs-guardrail-demo#16, release v0.6.0) |
| Tree | `dc25f122da3183c14cd70fa14deabdd4d1b1fe45` | `7eb9f3368df5c83d6fb65c79ca867df0bf19e41c` |
| Version | `0.5.0` | `0.6.0` |
| Tag | `v0.5.0`, object `f0626086…` | `v0.6.0`, annotated tag object `c83cd669d3b7bdea203d368102cb266e669f7752` |
| package-lock SHA-256 | `6d40e36d…` | `b8be539447e54a3cca6b2011df3cce7396f9f73a37ffb0cc6cc419fcd76b7c3d` |
| Runtime mode | `tenancy`, chain length 8 | `tenancy`, chain length 8, **`sut_lifecycle_mode: permit`** |
| SUT baseline | 30 suites / 628 tests | **33 suites / 774 tests** (`npm run verify`, Node 22 and 24) |
| Runtime-own gates | tenant `4d0be44a…`, ancestor `5d7d5001…`, R1–R4 | the same tenant and ancestor bindings, R1–R4; **lifecycle** `80952ae5…` (26 entries, 20 mechanisms, 6 variants), **RL1–RL24**, **witness determinism** |
| Profile | `…a9deab6.profile.json` (17/10, K = 43), format 2 | `…ef775db.profile.json` (**23/4, K = 57**), format 3, lifecycle capability rules |
| Supplement | S1–S10 | **S1–S14** (S1, S2, S7, S8 re-mapped; S3–S6, S9, S10 byte-identical content; S11–S14 new) |

Unchanged:
- the ACS track (`sut.lock.json`, `403d315`) and its baseline;
- the golden 27-case corpus and the oracle;
- the contract (`revocation-0.4.0`).

The `a9deab6` and `a682e44` locks are kept in `profiles/revocation/history/`, each with its profile, supplement and recorded observations, for the recorded re-evaluation only.

## 2. Baseline at the pin

*Observed in the integration runs before the final head. These are the values the final validation must reproduce; its confirmed results are recorded per §7.*

- **Adapter run.** `run-adapter --verify-baseline` reproduced the SUT baseline (33 suites / 774 tests) and verified the tag.
- **Corpus.** **23/23 IN_PROFILE PASS**; 4 OUT_OF_SCOPE without verdict: `late-commit-after-terminal` and `cancel-is-not-rollback` (G6), `retry-after-revocation` (G5b), `execution-id-reuse` (G5a, G5b). Corpus coverage is 23/27.
- **Unassessed finish/seal decisions: 57.** The six moved cases add 14 (2, 2, 3, 2, 3, 2). A test checks this against the profile and the classifier.
- **Supplement.** S1–S3 and S5–S14 PASS; S4 is exactly UNASSESSABLE with its declared incompleteness. `supplement_acceptance_passed: true`, reported apart from corpus coverage.
- **Acceptance.** `contract_acceptance_passed: false`, `profile_acceptance_passed: true`, `technically_valid: true`, **exit 3**.
- **Determinism.** Two clean `run-adapter` runs give byte-identical observations, evidence and supplement evidence. The observations equal the committed fixture `test/fixtures/revocation-runtime/ef775db-baseline-observations.json`.
- **Recorded path.** `evaluate --observations --profile --lock` on the recorded observations gives byte-identical evidence, supplement evidence and observations, equal acceptance fields, and exit 3.
- **Earlier pins**, re-evaluated under their historical locks:
  - `a9deab6` (format 2): 17/17 PASS, K = 43, exit 3. Evidence, supplement evidence and observations are byte-identical to the report of eval `main` at `2e459ad`.
  - `a682e44` (format 1): 14/14 PASS, exit 3.

## 3. What the lifecycle cases show

| Case | Lifecycle (plan §§6, 7.3) | Observed at the pin |
|---|---|---|
| `pending-approval` | approve, issue, start of a revoked pending authority | approve DENY (`AuthorityRevokedError`, stage approval), issue DENY (`not_approved`), start DENY; no lifecycle effect, no tool call |
| `issue-after-cut` | approval before the cut stays; issue after it | `approval_granted@0`; issue DENY (stage issue), start DENY |
| `fresh-id-retry-unused-permit` | start before issue; fresh-ID retry against a revoked unused permit | start DENY `permit_not_issued`; approve and issue ALLOW; the retry is denied after the revocation |
| `derived-authority` | ancestor revocation reaches a descendant's start and a pending grandchild's approve and issue | start DENY; approve DENY; issue DENY |
| `permit-single-use` | single use | first start runs, commits, delivers; the retry DENY `permit_consumed`; the consumption is bound to the first start's request and execution |
| `approval-before-cut` | a complete lifecycle before the cut | `approval_granted@0`, `permit_issued@1`, start, commit, delivery, terminal; the revocation after the terminal changes nothing |
| `issued-permit`, `cut-before-start`, `duplicate-revocation` | revocation of an authority holding an issued, unused permit | denials at start; the permit stays unused (family caveats removed) |
| S1, S7, S8 | approve, issue and start of a pending authority after a capability, tenant or ancestor revocation | all DENY; nothing approved, issued or started |
| S2 | non-vacuity of S1 | approve, issue and start ALLOW, each effect at its own step (now the contract oracle's expectation) |
| S11 | session revocation covers a pending approval | `a` approve, issue, start DENY; `b` in another session approved, issued, started |
| S12 | tenant revocation covers an unused permit | both permits issued before the cut; `a` start DENY, `b` (other tenant) runs |
| S13 | ancestor revocation covers a descendant's unused permit | `c` start DENY, `q` runs |
| S14 | ancestor revocation between a descendant's approve and issue | `approval_granted@0` stays; issue and start DENY |

The setup approve and issue of `initial: issued` authorities precede the setup baseline and are never step effects (AR1). Every lineage is confirmed in its initial state by the baseline (AR2).

## 4. Evidence kinds

The layers of plan §7.1 stay apart:
- **corpus** (`evidence.jsonl`);
- **supplement** (`supplement-evidence.jsonl`);
- **runtime-own tests** (`runtime-gates.json`);
- **component evidence**, which exists only in the runtime-own gates.

Within the gates, the evidence parts are reported separately and never merged:

| Part | Eval gate (witness effect findings, `mutants.json`) | Runtime-own gates (`runtime-gates.json`) |
|---|---|---|
| Containment | an unexpected start, commit or delivery, or a side effect after the terminal | `both`, `containment_effect` |
| Lifecycle | an unexpected approval or permit | `lifecycle_effect`, `check_and_lifecycle` |
| Availability | a missing start, commit, delivery, approval or permit | `availability_effect`, `check_and_availability` |
| Signal | cancellation and revocation acknowledgements, premature or unexpected terminals | — |
| Check point only | decision findings only | `check_point` |
| Component | none (the eval sees only the public API) | `component_check_point` |
| Missing evidence | UNASSESSABLE without findings (M10) | — |

**Earlier kinds, re-checked.** The eval gate's evidence kinds (`decision_and_effect`, `effect`, `missing_evidence`) are kept. Re-checked against the split:
- **Signal, not containment:** M1 (premature terminal), M5, M29 and M36 (missing cancellation acknowledgement), M11 (unexpected terminal). Signal evidence stands beside containment and is never counted as it.
- **Availability, not containment:** M7, M16 and M37 (over-reach). They show denied allowed work.
- **Containment and signal:** M6, M14, M24, M49 and M51. A tool that must not run did run, and its execution also ended with an unexpected terminal.
- **Lifecycle only:** M12, M13, M50 and M52. The later fences still deny the start, and this is observed in the same witness (decision DENY, no tool call).

## 4a. Gate expectations (pinned values)

**This section states expected values, not results.** They are the values the lock and the mutant manifest pin, and every gate run must reproduce them exactly. Whether the final run on the final committed head did so is recorded separately (§7): a document cannot record a run of the commit that contains it.

The mutant manifest is `mutations/revocation/manifest.json`, SHA-256 `77f62e6f6481587a117fc06c5516289aff5ca4dfea2c6a81d9894c05b3281fcf`. It was committed before any final gate run. It replaces the pin `29cd7ef3…`, which the evaluator fix of §6 (two-way consumption binding) invalidated for M24 only. Intermediate runs on `0d4d375`, `3bdb879` and `31ff08e` showed the earlier values, and runs on `31460ec` and `f0b2450` showed these values with an evaluator that §6 later corrected; none of them is the final evidence.

**Eval mutant gate** (`mutants --lock --profile`), expected:
- **Control:** exit 3, without any exception.
- **Detected: 26/26 SUT mutants.** Each matched exactly its manifest values and run exceptions: M4 has 1 predeclared harness error, M10 has 29 predeclared barrier timeouts, the others have none. 0 survived, 0 technical failures.
- **Masked: 6/6 as pinned** (M8, M9, M20, M22, M26, M34). Each run equals the control. They are recorded gaps, not detections.
- **Not run: M25**, with its conflict, reproduction and coverage gap.
- **Adapter mutants: AM1–AM19, 19/19 detected.**
- Gate exit 0.

| Evidence part | Mutants (expected detections) |
|---|---|
| Containment | M2, M3, M4, M6, M15, M21, M28, M35, M14, M24, M49, M51 |
| Lifecycle | M12, M13, M50, M52 |
| Availability | M7, M16, M37, M25-overreach |
| Signal | M1, M5, M6, M11, M29, M36, M14, M24, M49, M51 |
| Check point only | — |
| Missing evidence | M10 |
| Component | none in the eval gate |

A mutant whose witness shows several parts is listed under each, and the parts are never merged.

| Mutant | Witness | Exit | Why that exit |
|---|---|---|---|
| M12, M13, M49–M52 | as in plan §8.1 | 1 | confirmed VIOLATION, every case technically valid |
| M24 | `permit-single-use` | 2 | confirmed VIOLATION (`false_allow@1`, `unexpected_execution_started@1`, `unexpected_execution_terminal@5`) with incompleteness: the patched runtime records no consumption, so the starts of e1 (probe 2) and of the retry (probe 5) have no permit consumption of their own. The 23 other cases with an observed start are UNASSESSABLE for the same reason. No harness error, no barrier timeout. |
| M14 | `fresh-id-retry-unused-permit` | 2 | confirmed VIOLATION with contradictory permit evidence (a permit consumed without an issue sequence value) |
| M25-overreach | S11 | 2 | confirmed VIOLATION; the only incompleteness is the pinned missing evidence `terminal evidence missing for e2 in window 8..9` (e2 is never started). The findings `false_deny@5`, `missing_permit_issued@5`, `false_deny@6` and `missing_execution_started@6` are retained. No harness error, no barrier timeout, no other changed case. |
| M1, M4, M7, M10, M16, M37 | unchanged from the earlier pin | 2 | unchanged reasons (pin review a9deab6 §5) |

**Gate regressions G1–G8** (real pinned runtime), required results:
- G1, G5: detected, exit 0.
- G6: masked, exit 0.
- G2, G3, G4, G7 and G8: technical failure, exit 2, each with its required reason.

**Evaluator regressions** (0.3.0 step path), required: all four regression mutants caught, the control passing and the self-test exit 0.

**Runtime-own gates** (`runtime-gates --lock`, every pinned gate), expected as pinned in the lock:
- tenant 19/19 and ancestor 25/25, with the four evidence kinds of the lock. The v0.6.0 driver also reports the lifecycle and availability kinds for these gates. They are accepted only when empty (`evidenceKindIssues`, with a regression test).
- lifecycle 26/26 with the lock's eight kind lists, counts, variants, entries beyond their kind and recorded gaps;
- R1–R4 and RL1–RL24 with their pinned exits;
- witness determinism: three identical runs.

These results are runtime-own evidence and are reported apart from the eval gate.

## 5. Re-verification of the existing mutants under permit mode

*Precheck observations: they were made before the manifest was pinned, and the manifest pins them. The final gate run must reproduce them (§7).*

Every existing patch was run against `ef775db` in permit mode, with the whole profile and supplement, and compared case by case with the control. Applying the patch was not taken as evidence.
- **Eval-side patches.** They were regenerated against `ef775db`: the same changed lines, with the hunk offsets and index lines of the new tree.
- **Copied patches** (M15, M16, M20–M22, M26, M28, M29, M34–M36) are byte-identical to the runtime's own patches at `ef775db`. Their source is now bound to `ef775db`.

| Mutant | Result under permit mode |
|---|---|
| M1–M7, M10, M11, M15, M16, M21, M28, M29, M35–M37 | **Same witness, identical values** (verdict, findings, incompleteness, errors, exit, `has_confirmed_violation`) |
| **M24** (after the evaluator fix, §6) | Same witness and findings; now incomplete and exit 2 (§4a). A full precheck of every mutant with the fixed evaluator changed no other mutant, masked mutant or the control. |
| **M25-overreach** (new, authorized) | S11 step 5, availability (§5a); not evidence of the original M25 property |
| M10 | Same witness values. Its predeclared barrier timeouts change from 24 to 29: the moved cases `approval-before-cut`@5 and `permit-single-use`@4, the new S11–S13 (step 8), and S2's re-mapped finish (step 3 instead of 1). They are pinned case by case. |
| **M8, M9, M20, M22, M26, M34** | **Masked: no case changes. They are not detected mutants; their earlier legacy-path witnesses (at `a9deab6`) stay historical evidence.** They remove or weaken checks on the legacy paths (`resolveApproval()`, the start inside `process()`, and the `#denyIfRevoked` stage checks), which permit mode reaches only at setup, before any revocation. M9's request- and start-stage checks are masked by the kept lineage fences (plan §8.1, M49). They are pinned as `masked`: their whole run must equal the control, they are never a detection, and their earlier witnesses are recorded. The permit-mode counterparts are witnessed: M12 and M50 (approval fence), M13 and M52 (issue fence), M49 and M51 (start path); also the runtime-own lifecycle gate. |
| AM1–AM13 | Re-verified against the real build in permit mode (AM3 on `sibling-isolation`, AM5 on S4 and M10, AM10 on M11, AM11–AM13 as before) |

## 5a. Precheck of M25-overreach

Patch `mutations/revocation/M25-overreach-issue-session-revocation-covers-other-sessions.patch` (one file, `src/guarded-executor.ts`). The precheck ran it with the whole profile and supplement against `ef775db`, through the gate's own path: fresh checkout, patch-effect check, SUT typecheck and build.
- **Setup.** Every case's setup succeeded with unchanged runtime API calls. There is no `setup_failed`, no diagnostic and no harness error.
- **Changed cases.** Only S11 `sup-session-revoke-pending-approval` changes:
  - findings: `false_deny@5`, `missing_permit_issued@5`, `false_deny@6`, `missing_execution_started@6`;
  - incompleteness: `terminal evidence missing for e2 in window 8..9`, because e2 never starts;
  - run exit 2, with `has_confirmed_violation` true.
- **Evidence kind:** availability, an unjustified denial of the lifecycle right at the issue fence. It is not containment.

The manifest pins exactly these values and no run exceptions.

## 6. Deviations from the plan and refinements

- **M25 is not run (conflict reported before any substitute; decided).**
  - **The plan.** M25 is an over-fencing control: "the issue state check requires `pending` instead of `approved`", with its witness at `approval-before-cut` step 1.
  - **The conflict.** The plan's own setup (§7.2, D2) creates every `initial: issued` authority through `approve()` and `issuePermit()`. The patch therefore also denies those setup issues (`not_approved`). Every case with such an authority fails its setup, which is a harness process error that no manifest entry may predeclare.
  - **Reproduction.** Precheck of `mutations/revocation/M25-issue-requires-pending-over-fencing.patch`: 19 corpus and 9 supplement cases report `setup_failed` ("setup approve and issue of a's lineage failed: Lifecycle issue denied: not_approved [lineage-1]") and HARNESS_ERROR `identity_mapping_invalid`, because no setup baseline was taken. The witness alone would show `false_deny@1`, `missing_permit_issued@1` and more. The whole run is a technical failure.
  - **Decision.** M25 stays under `not_run` with this reproduction; the patch file is kept for it.
    - A setup failure is never accepted as a safety finding.
    - The mutant is never switched off for the setup.
    - The loss of the issue state requirement is recorded as a **coverage gap**: it has no eval mutant evidence. The requirement itself is still observed: `pending-approval` step 2, and the runtime-own test L10.
  - **`M25-overreach` (separately authorized).** A new mechanism:
    - only the issue fence changes: a session revocation of another session of the same tenant also covers the issued lineage;
    - witness: S11 step 5 (ALLOW in the control, DENY under the mutant);
    - the setup runs unchanged runtime API calls;
    - evidence kind: an unjustified denial at a check point of the lifecycle right (availability), never containment.

    It is neither evidence of the original M25 property nor a variant of the M25 patch. Its precheck values are in §5a.
- **27 newly assessed decisions, not 28 (decision: corrected in the plan).** The earlier plan §6 counted step range 0–6 for `approval-before-cut`, but its step 5 is a finish (K). The six moved cases have 41 decisions, 14 of them K. The plan and every reference now say 27. The coverage target is unchanged (23/27, K = 57, exit 3), and the corpus and the oracle are unchanged.
- **M14's witness exceeds the plan's minimum.** The patched runtime consumes a permit that was never issued: `permit_state` goes `none → consumed`, with no `issued_seq`.
  - By the §7.1 rule this is contradictory permit evidence. The expected `permit_issued@2` stays unconfirmed, and the run exits 2.
  - The witness also shows `false_deny@2`: the issue is denied because the lineage is consumed. It also shows the started execution's unexpected terminal.
  - All of these values are pinned.
- **M12, M13, M50 and M52 are lifecycle evidence only.** The issue and the start of each witness are still denied by their own fences, so no tool runs. The plan's kind "check and lifecycle" matches.
- **M14, M24, M49 and M51.** The plan's kind is "both". The eval gate reports them as containment plus signal: the started execution also ends with an unexpected terminal.
- **The execution label in permit mode.** Arguments are bound by digest, so the request marker can no longer name the execution. The label comes from the runtime's `request_id` of the execution: the R′ of exactly one start step. The evaluator checks it (`runtime_binding_mismatch`). The consumption's `start_request_id` and `execution_id` must also match their own start step (`lifecycle_transition_mismatch`).
- **Evaluator fix after review of `31ff08e`: two-way consumption binding and authority-scoped lifecycle contradictions.** Two evidence evaluation defects were reproduced on recorded observations (direct and through `evaluate --observations`):
  - `permit-single-use` with the consumption state, `consumed_seq`, execution id and start request id removed gave PASS; a consumption bound to an execution id no observed execution has also gave PASS.
  - In S11, with b's permit effect removed at step 5 the case is VIOLATION `missing_permit_issued@5`; adding a contradictory permit sequence of a turned it UNASSESSABLE and the finding disappeared. The same held for `approval_granted` (`missing_approval_granted@4` in `approval-before-cut`).

  The fix (§14.3 and §14.5 of the compatibility spec): every observed start needs its own lineage's consumption with the right request and execution ids, or its evidence is incomplete; a consumption naming an unobserved execution is `lifecycle_transition_mismatch`; a lifecycle contradiction concerns only its own authority (and named execution), with the barrier-based temporal scope kept. The regressions (`runtime-permit.test.ts`) fail at `31ff08e` and pass after the fix, on both paths. The corpus, the oracle and the runtime pin are unchanged. Only M24 changed (§5).
- **Follow-up after review of `31460ec`: the consumption's bindings come from its first snapshot.** The start-to-consumption check read the consumption's `execution_id` and `start_request_id` from the last snapshot, so an id that appears only after the start step completed the missing binding. Reproduction on recorded observations: `permit-single-use` with the consumption's `execution_id` removed from its first consumption probe, or from every probe of start step 0, gave PASS (exit 3 through `evaluate --observations`). Now both bindings are read from the snapshot that first shows the consumption: either case is UNASSESSABLE (`start:e1: execution started with no permit consumption of its own`), exit 2. A start request missing from the first consumption probe was already `lifecycle_transition_mismatch` (exit 2), and its regression is kept. Observed starts, confirmed findings and the authority scope are unchanged. A full precheck of every mutant gives exactly the values pinned in the manifest (`77f62e6f…`, unchanged).
- **Follow-up after review of `f0b2450`: a confirmed consumption binding persists.** A binding confirmed where the consumption is first shown was not checked in later probes. Changing or dropping the consumption's `execution_id` or `start_request_id` after the start step of `permit-single-use` gave PASS (exit 3). Such a change is now a contradiction of that consumption: UNASSESSABLE, exit 2 through `evaluate --observations`. With a confirmed finding of another fact, the finding stays. In S11, b's execution changes after its consumption, while b's permit is hidden at step 5: VIOLATION `missing_permit_issued@5`, exit 2. Observed starts are kept. A binding missing in the first probe and supplied later stays UNASSESSABLE. A full precheck of every mutant again gives exactly the pinned values (manifest unchanged).
- **Decision mapping.** Only the contract's lifecycle denials are DENY: `not_pending`, `not_approved`, `permit_not_issued` and `permit_consumed`. Any other `LifecycleDeniedError` is UNKNOWN, so an adapter or binding defect cannot pass as a contract denial. A call through another API than its operation's is `call_api_mismatch`.

## 7. Final validation

**Procedure.** The final validation runs on the final committed head, with a clean worktree, in two parts. Each run must show the stated result:
- **Part 1 (harness):**
  - `npm run build`, `npm run typecheck`, `npm run check:oracle-boundary` (no violations) and `npm test` (no failure; the skipped tests are the pinned-SUT tests, run separately);
  - the pinned-SUT tests (`runtime-sut.test.ts` with `ACE_REVOCATION_WORK`): no failure and **no skip**;
  - two clean `run-adapter --verify-baseline` runs: exit 3, `diff -r` identical, and observations equal to the committed fixture;
  - recorded re-evaluation: byte-identical evidence, supplement evidence and observations, exit 3;
  - the earlier pins under their historical locks: `a9deab6` 17/17 (K = 43) and `a682e44` 14/14, both exit 3;
  - the eval mutant gate (§4a, exit 0), gate regressions G1–G8 (runner exit 0) and evaluator regressions (exit 0).
- **Part 2 (runtime-own):** `runtime-gates` with every pinned gate (§4a, exit 0).
- **CI** on Node 22 and 24 runs the same steps on the pushed head.

**Confirmed results.** The confirmed results of the final head are recorded in the pull request, mikko-lab/agent-control-evals#17. They give the commit SHA, the exit of every run and the evidence values, and they rest on the run outputs (reports and SHA-256 of the manifests). They are not restated here, because this file is part of the commit they validate.

## 8. Open risks and limits

- **Declared profile.** Exit 3 is never a contract pass. 4 corpus cases (G5, G6) and 57 finish/seal decisions stay unassessed.
- **Masked mutants.** In permit mode, six existing mutants (M8, M9, M20, M22, M26, M34) are recorded gaps of the eval gate. Their checks remain covered by the runtime-own tenant and ancestor gates, and their permit-mode counterparts by M12, M13 and M49–M52.
- **M25:** the loss of the issue state requirement has no eval mutant evidence (coverage gap, §6). `M25-overreach` is a separate mechanism and does not close this gap.
- **Runtime-own gaps**, from the lock and the lifecycle gate report:
  - M55, M56 and M71 are component evidence only;
  - M70 at approve and issue is masked;
  - M61–M63, M68, M69 and M70-create are lifecycle evidence only: that a later fence still denies is inferred, not run;
  - the gate limitations A5–A9 stay (runtime `docs/mutant-gate.md`);
  - the tenant and ancestor gates are not on the strict whole-run rule.
- **The setup creates lineages through the same runtime paths** (process, approve, issue) that some mutants change. A mutant that breaks the setup can only ever be a technical failure in the eval gate (M25). Such checks need runtime-own witnesses.
- **The execution identity fence** (G5) stays uncovered. Expiry and reject are runtime-specific and are tested only by the runtime (plan §12).
- **Unchanged runtime limits.** Revocation and the lifecycle are in memory, for one executor in one process. Cancellation is cooperative. The commit fence covers only `ctx.commit()`.
