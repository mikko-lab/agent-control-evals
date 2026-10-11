# SUT pin review — revocation track, `acs-guardrail-demo` v0.5.0 @ `a9deab6`

Status: **review record of the eval integration of coverage expansion package 1** (G1 tenant scope, G2 ancestor revocation). It records what the new pin binds, the baseline, the evidence kinds, the deviations from the approved [plan](coverage-expansion-plan.md) and the open risks. The adapter rules are in [§13 of the compatibility specification](runtime-adapter-compatibility.md#13-revision-for-the-v050-pin-coverage-expansion-package-1).

## 1. Pin

| Binding | Earlier pin (`profiles/revocation/history/sut.revocation.a682e44.lock.json`) | New pin (`sut.revocation.lock.json`) |
|---|---|---|
| Commit | `a682e4479dbccd1cd5f665f5d4879bd3dddb8b47` | `a9deab6709d6ca2ba8f3988693b50fa807eadc0c` |
| Tree | `1346e92e64aff16183df84ea126271644498190a` | `dc25f122da3183c14cd70fa14deabdd4d1b1fe45` |
| Version | `0.4.0` | `0.5.0` |
| Tag | — | `v0.5.0`, annotated tag object `f0626086faf5757e58fa1a746d4b12fe1ceb3e47` (additional identifier; must point at the commit) |
| package-lock SHA-256 | unchanged field | `6d40e36d07aeaaa8546be5c1c223ede585828db72d26d067c399988c27649e4c` |
| Runtime mode | legacy | `tenancy`, `max_chain_length` 8 (leaf included; the built runtime must export it) |
| SUT baseline | as recorded | 30 suites / 628 tests (`npm run verify`, Node 22 and 24) |
| Runtime-own gates | — | tenant manifest `4d0be44a…`, ancestor manifest `5d7d5001…`, regressions R1–R4 with exits 2/2/0/2 |
| Profile | `acs-guardrail-demo-a682e44.profile.json` (14/13) | `acs-guardrail-demo-a9deab6.profile.json` (17/10), observation format 2 |
| Supplement | S1–S4 | S1–S10 (S1–S4 byte-identical case content) |

The ACS track (`sut.lock.json`, `403d315`) and its baseline are unchanged. The golden 27-case corpus is unchanged.

Loading fails closed on: a tag name other than `v<version>`, a tag object that is not a 40-hex SHA or equals the commit, an unknown runtime mode, a tenancy lock without a positive chain length or a legacy lock with one, a malformed runtime gate binding (command, manifest hash, the four evidence kinds, duplicate mutants, gaps, regression exits). Before every checkout the tag is fetched into a harness-only ref and must be the pinned annotated tag object pointing at the commit; the checkout must have the pinned tree, package-lock bytes and both runtime gate manifests; the build must export `MAX_CHAIN_LENGTH === 8`. The tag never selects what runs: the commit and the content hashes do.

## 2. Baseline at the pin

- `run-adapter --verify-baseline`: SUT baseline reproduced (30 suites / 628 tests), tag verified.
- Corpus: **17/17 IN_PROFILE PASS**, 10 OUT_OF_SCOPE without verdict, corpus coverage 17/27.
- Unassessed finish/seal decisions: **43** (34 + 4 `tenant-multi-session-in-flight` + 3 `tenant-isolation` + 2 `derived-in-flight-ancestor-revoked`), checked by test against the profile and the classifier.
- Supplement: S1–S3 and S5–S10 PASS; S4 exactly UNASSESSABLE with its declared incompleteness. `supplement_acceptance_passed: true`, reported apart from corpus coverage.
- `contract_acceptance_passed: false`, `profile_acceptance_passed: true`, `technically_valid: true`, **exit 3**.
- **Determinism:** two clean `run-adapter` runs give byte-identical bundles (`diff -r`), and the observations equal the committed fixture `test/fixtures/revocation-runtime/a9deab6-baseline-observations.json`.
- **Recorded path:** `evaluate --observations --profile --lock` on the recorded observations gives byte-identical `evidence.jsonl`, `supplement-evidence.jsonl` and `observations.json`, equal acceptance fields and exit 3.
- **Earlier pin:** the `a682e44` format 1 observations are re-evaluated unchanged under the historical lock (14/14 PASS, 34 K, exit 3), and the format 1 regressions in `runtime-profile.test.ts` pass unchanged.

## 3. What the new cases and supplement cases show

| Case | Fence (plan §7.3) | Observed at the pin |
|---|---|---|
| `tenant-multi-session-in-flight` | commit (tenant), non-coverage of the other tenant | One tenant receipt for `t1`; both of `t1`'s sessions denied at commit; `t2` commits and delivers |
| `tenant-isolation` | request (tenant), over-reach at start, commit, delivery | `t1`'s start denied at the request; `t2` starts, commits, delivers |
| `derived-in-flight-ancestor-revoked` | commit (ancestor) | One capability receipt for `a`; the child's commit denied |
| `sibling-isolation` | over-reach of a capability revocation | With parent links mapped, revoking `child` reaches neither `a` nor the sibling |
| S5 / S6 | request (ancestor) / non-vacuity | Child start denied after `a` is revoked; the same valid chain starts without revocation |
| S7 / S8 | approval (tenant / ancestor) | The pending approval is denied after the revocation; the tool is never invoked |
| S9 / S10 | commit before the cut, cancellation signal, delivery, non-coverage | Commits before the cut stay; `cancel_ack` ALLOW for the covered execution; its delivery withheld (`tenant_revoked` / `ancestor_revoked`); the uncovered execution delivers |

The start guard is claimed by runtime-own evidence only (plan §7.3).

## 4. Evidence kinds

The three kinds of plan §7.2 stay apart in the reports:

1. **Corpus** (`evidence.jsonl`, counts toward corpus coverage and `profile_acceptance_passed`).
2. **Supplement** (`supplement-evidence.jsonl`, counts only toward `supplement_acceptance_passed`).
3. **Runtime-own tests** (`runtime-gates.json`): the pinned runtime's own mutant gates and gate regressions, compared with the lock. Within them, `both` and `containment_effect` are containment evidence, `check_point` is check-point evidence only, `component_check_point` is never production-path evidence.

The eval mutant gate (`mutants.json`) reports each mutant's evidence kind from its manifest: `decision_and_effect` (a decision finding and an effect finding), `effect` (effect findings only: M1, M11) and `missing_evidence` (M10: detected only through missing terminal evidence, never as a violation; its barrier timeouts are predeclared one by one, not exempt as a class). Decisions and effects are observed separately; no audit event or API receipt stands in for state evidence.

## 4a. Gate results

**Eval mutant gate** (`mutants --lock --profile`, manifest `mutations/revocation/manifest.json`, SHA-256 `3e1f95e611978e6bb297c369c80855c718f5e12479e5629111b79f31cb338568`, committed in `0d3347e` before the final run): control exit 3; **23/23 SUT mutants detected** with exactly their manifest values, 0 survived, 0 technical failures; **AM1–AM13 13/13 detected**; gate exit 0.

| Mutant | Witness | Exit | Evidence kind |
|---|---|---|---|
| M1 | `commit-before-cut` | 2 | effect |
| M2, M5, M6, M9 | `start-before-cut`, `in-flight-before-commit`, `active-session`, `cut-before-start` | 1 | decision and effect |
| M3, M8, M11 | S3, S1, S4 | 1 | decision and effect (M3, M8), effect (M11) |
| M4, M7 | `session-delivery-fence-after-commit`, `sibling-isolation` | 2 | decision and effect |
| M10 | `start-before-cut` | 2 | missing evidence |
| M15, M21, M22 | `tenant-multi-session-in-flight`, `derived-in-flight-ancestor-revoked`, `tenant-isolation` | 1 | decision and effect |
| M16, M37 | `tenant-isolation`, `sibling-isolation` | 2 | decision and effect |
| M20, M26, M34 | S5, S7, S8 | 1 | decision and effect |
| M28, M29 | S9 (`false_allow@6` + `unexpected_output_delivery@6`; `false_deny@5` + `missing_cancellation_ack@5`) | 1 | decision and effect |
| M35, M36 | S10 (same steps as S9) | 1 | decision and effect |

| Adapter mutant | Detection |
|---|---|
| AM11 | `tenant-multi-session-in-flight` and S9: HARNESS_ERROR `revocation_target_mismatch` |
| AM12 | `tenant-isolation`: HARNESS_ERROR `identity_mapping_invalid` (the runtime also refuses the second tenant's grant: `false_deny@2`) |
| AM13 | `derived-in-flight-ancestor-revoked` and S5: HARNESS_ERROR `identity_mapping_invalid`; S5 additionally `false_allow@1`, `unexpected_execution_started@1` |
| AM1–AM10 | As before, re-verified at the new pin (AM3 on `sibling-isolation` with mapped parent links, AM5 on S4 and M10, AM10 on M11) |

**Runtime-own gates** (`runtime-gates --lock`): tenant 19/19 and ancestor 25/25 detected with exactly the lock's evidence lists and recorded gaps, regressions R1–R4 with exits 2/2/0/2; CI green on Node 22 and 24 (`0d3347e`).

| Gate | both | containment_effect | check_point | component_check_point | Recorded gaps |
|---|---|---|---|---|---|
| tenant | M15, M16, M22, M26, M27c, M28, M28b, M30, M30b, M31, M32 | M29 | M26a, M27a, M27e, M27f, M28a, M33b | M33 | M33: no production-path witness |
| ancestor | M20, M21, M27d, M34, M35, M35b, M37, M38, M39, M41, M42b, M42c, M43, M44, M45, M46 | M36 | M27b, M27g, M34a, M35a, M40, M42a, M47, M48 | — | — |

## 5. Deviations from the plan and refinements

- **M37 is an eval-side patch.** The runtime gate's M37 propagates a revocation to parent and siblings when `revoke()` is called. In `sibling-isolation` the child is revoked before any capability is bound, so it would have nothing to propagate to. The eval's M37 walks the revoked capability's lineage at check time instead (same defect, reachable through the contract). All other package 1 patches (M15, M16, M20–M22, M26, M28, M29, M34–M36) are copied byte for byte from the runtime gate, with source path and hash in the manifest.
- **Exact witnesses.** The plan names the findings each mutant must produce. The manifest pins the complete values, so a detection needs exactly them. Besides the plan's findings, a start that should have been denied also has an unexpected terminal (M6, M8, M9, M20, M22, M26, M34), and an over-reaching denial also leaves the denied execution's later commit and delivery missing (M7, M16, M37).
- **Exits 2 for detected mutants.** M1, M4, M7, M10, M16 and M37 are detected with run exit 2. Each manifest entry gives the reason: incompleteness beside the confirmed findings (M1, M7, M16, M37), a causally impossible trace in another case (M4: delivery after a denied commit), or missing evidence only (M10). In every case but M10 the witness is a confirmed VIOLATION, and the manifest also pins `has_confirmed_violation`.
- **Technical failures.** A patch that does not apply, changes another file than its target or does not typecheck aborts the gate (exit 2). Every whole mutant run is checked for technical errors before it is classified (§5a). Any of the following is a technical failure, and none of them is ever a kill:
  - a harness process diagnostic (`adapter_abort`, `setup_failed`, `constructor_getter_ran`);
  - any evaluator error or barrier timeout, in any case, that the mutant's `run_exceptions` do not predeclare;
  - a different case inventory;
  - a witness value that is neither the control's nor the manifest's.

  During the precheck the gate correctly aborted on a wrong target file for M15 and M21 (`managed-execution.ts` instead of `guarded-executor.ts`). The manifest generator now derives targets from the patches, and the manifest loader checks them before any build.
- **AM11–AM13 detection.** AM11 is caught by the new probe-log receipt check (`revocation_target_mismatch`: several session receipts for one tenant revocation). AM12 and AM13 are caught by the identity-mapping check (`identity_mapping_invalid`); AM13 additionally makes S5's start succeed (`false_allow@1`), so the missing parent link is visible in the effects too. AM8 is now also caught by the identity check.
- **Runtime gates in CI** run as a matrix over Node 22/24 and the three gates (tenant, ancestor, regressions) for wall-clock reasons; `runtime-gates` without `--gates` runs all three.

## 5a. Review finding at `57edc4a`: the mutant gate ignored technical errors outside the witness

**Finding.** The review reproduced it with the real pinned runtime and the M1 patch. A schema-violating field added to the `issued-permit` observation made that case a HARNESS_ERROR (`malformed_observation`). The gate still reported M1 as detected with exit 0, because its classification looked only at the witness case and a short list of diagnostics; changes in other cases were diagnostics only. In the same way, every barrier timeout of a `missing_evidence` mutant (M10) was exempt as a class.

**Fix.**
- The gate checks the whole run before classifying (`classifyMutantRun`, `src/mutation/revocation/mutants.ts`).
- The manifest predeclares `run_exceptions` per mutant, case by case and exactly:
  - M4: one `causally_impossible` error in `in-flight-before-commit` (path and message pinned);
  - M10: 24 finish-barrier timeouts (case, step and detail pinned);
  - every other mutant: none.
- A predeclared exception allows nothing else, not even a second error of the same kind, and its absence means no detection. The control run must have no exception at all.
- The values come from two independent runs, which agreed exactly.

**Gate regressions G1–G5** (compatibility spec §13.6) run the real runtime:
- at `46d0be9` (the classification of `57edc4a` plus only the regression seam): see §4a;
- after the fix: see §4a.

## 6. Open risks and limits

- The profile is a declared profile: exit 3 is never a contract pass; 10 corpus cases and 43 finish/seal decisions stay unassessed.
- Revocation in the runtime is in-memory, single-process and cooperative; the eval observes only `ctx.commit()` on managed state and the runtime's delivery records.
- Tenants share one issuer key and one executor; they are not separate trust domains (runtime limitation, v0.5.0 release notes).
- **M33** (tenant field of the capability fingerprint) has component evidence only; the gap is recorded in the lock and repeated in the runtime gate report.
- **M42a** covers re-resolution of the chain at the commit fence only; the delivery checks and the cancellation fan-out share the start-time binding without a re-resolution mutant of their own.
- M40, M47 and M48 are check-point evidence; ancestor expiry between request and approval has no isolated witness.
- The cancellation non-coverage of other tenants or unrelated authorities is runtime-own evidence only (the contract expects ALLOW for `cancel_ack` without a cancellation request).
- `derived-authority` stays OUT_OF_SCOPE until G3.
