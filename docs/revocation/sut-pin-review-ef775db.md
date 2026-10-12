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

## 4a. Gate results

(Filled in from the final runs on the final committed head; see §7.)

## 5. Re-verification of the existing mutants under permit mode

Every existing patch was run against `ef775db` in permit mode, with the whole profile and supplement, and compared case by case with the control. Applying the patch was not taken as evidence.
- **Eval-side patches.** They were regenerated against `ef775db`: the same changed lines, with the hunk offsets and index lines of the new tree.
- **Copied patches** (M15, M16, M20–M22, M26, M28, M29, M34–M36) are byte-identical to the runtime's own patches at `ef775db`. Their source is now bound to `ef775db`.

| Mutant | Result under permit mode |
|---|---|
| M1–M7, M10, M11, M15, M16, M21, M28, M29, M35–M37 | **Same witness, identical values** (verdict, findings, incompleteness, errors, exit, `has_confirmed_violation`) |
| M10 | Same witness values. Its predeclared barrier timeouts change from 24 to 29: the moved cases `approval-before-cut`@5 and `permit-single-use`@4, the new S11–S13 (step 8), and S2's re-mapped finish (step 3 instead of 1). They are pinned case by case. |
| **M8, M9, M20, M22, M26, M34** | **Masked: no case changes. They are not detected mutants; their earlier legacy-path witnesses (at `a9deab6`) stay historical evidence.** They remove or weaken checks on the legacy paths (`resolveApproval()`, the start inside `process()`, and the `#denyIfRevoked` stage checks), which permit mode reaches only at setup, before any revocation. M9's request- and start-stage checks are masked by the kept lineage fences (plan §8.1, M49). They are pinned as `masked`: their whole run must equal the control, they are never a detection, and their earlier witnesses are recorded. The permit-mode counterparts are witnessed: M12 and M50 (approval fence), M13 and M52 (issue fence), M49 and M51 (start path); also the runtime-own lifecycle gate. |
| AM1–AM13 | Re-verified against the real build in permit mode (AM3 on `sibling-isolation`, AM5 on S4 and M10, AM10 on M11, AM11–AM13 as before) |

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
- **Decision mapping.** Only the contract's lifecycle denials are DENY: `not_pending`, `not_approved`, `permit_not_issued` and `permit_consumed`. Any other `LifecycleDeniedError` is UNKNOWN, so an adapter or binding defect cannot pass as a contract denial. A call through another API than its operation's is `call_api_mismatch`.

## 7. Final validation

(Filled in from the final runs on the final committed head.)

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
