# External Action Boundary Evaluation: P1a

P1a implements the observation model and the evaluator of the [evaluation plan](evaluation-plan.md), under the [decisions](decisions.md) recorded for P1. It evaluates **fixed synthetic observations** only.

No guard, recipient double, network namespace, sandbox or canary runs in P1a. Every result here is **synthetic harness validation**: it shows how the evaluator treats given observations. It is not a measured security result for any guard. P1b (doubles, isolation, the reference guard and its XM mutants) is a separate work order.

## Running it

```sh
npm ci && npm run build
npm run ace:external -- self-test --out out/external-actions          # goldens, full baseline, RV1-RV6, AX1-AX7; exit 0 = gate passed
npm run ace:external -- evaluate \
  --observations test/fixtures/external-actions/p1a-baseline.observations.json \
  --profile profiles/external-actions/p1a-synthetic.profile.json --out out/recorded   # exit 0/1/2/3 (plan §7.2)
npm run ace:external -- oracle-boundary
node --test --test-concurrency=1 dist/test/external-actions/*.test.js
```

CI runs these steps in the `external-actions` job on Node 22 and Node 24, without `sudo`. It also reruns the self-test, compares the two bundles byte for byte, and compares the recorded-CLI evaluation with the in-process evaluation.

## What is where

| Piece | Where |
|---|---|
| Case and observation types, `logical_id`, journal entry hash | `src/external-actions/spec/model.ts` |
| P1 case definitions (13 cases; golden `corpus/external-actions/p1.jsonl` and `p1.sha256`) | `src/external-actions/corpus/cases.ts` |
| Oracle (reads case definitions only) | `src/external-actions/oracle/expected.ts` |
| Oracle import boundary check (new roots, plan §8) | `src/external-actions/oracle-boundary.ts` |
| Observation schema `external-action-observation/1` | `schemas/external-actions/observation-1.schema.json` |
| Evaluator and its rule table | `src/external-actions/eval/evaluate.ts` |
| Run, profile checks (non-vacuity) and exit | `src/external-actions/eval/run.ts` |
| Report and schema `external-action-report/1` | `src/external-actions/report/report.ts`, `schemas/external-actions/report-1.schema.json` |
| Profile pinning `T_w`, `T_q`, `T_r` and the delays (with `.sha256`) | `profiles/external-actions/p1a-synthetic.profile.json` |
| Fixture builder and catalog | `src/external-actions/fixtures/` |
| Committed fixtures (golden-checked against the builder) | `test/fixtures/external-actions/` |
| Adapter mutants AX1–AX7 | `src/external-actions/mutation/adapter-mutants.ts` |
| Pins of RV1–RV6 and AX1–AX7 (with `.sha256`) | `mutations/external-actions/` |
| Self-test and CLI | `src/external-actions/self-test.ts`, `src/external-actions-cli.ts` |

No file of the ACS, automotive or revocation tracks changes. The track shares only `src/util/canonical-json.ts` and `src/util/hash.ts` with them.

## The evaluator

### Evidence (plan §5.5)

- **Connections and requests.** A journal entry is the sufficient evidence. The counter delta in the latest snapshot is the cross-check, compared with the entries up to that snapshot's position in the journal. Connections and requests are counted apart.
- **Drafts.** A changed draft record in a snapshot is the sufficient evidence. A `draft_stored` entry is the cross-check. **Every observed change is evaluated in order**, so a later allowed draft never hides an earlier forbidden one. A change without its `draft_stored` entry, or an entry without a change, is a contradiction kept beside the result.
- **Submissions.** A record in a snapshot is the sufficient evidence, but only when its content digest derives its `logical_id`. A record whose content does not derive its identity is confirmed as a stored submission whose identity is uncertain:
  - every identity it may have is considered;
  - if all of them are unauthorized, it is a finding; otherwise the affected requirements are incomplete.

  Disagreement with its `submit_stored` or `submit_received` entry is a contradiction kept beside the record.
- **Record versions.** A record that changes between snapshots is detected. Every version is kept as evidence, and a later version never overwrites an earlier one. Only a record that disappears is a harness error.
- **Submission attempts.** Each `submit_received` is classified at final closure as §5.5 tabulates. A received and rejected attempt with no record is a confirmed absence, not a contradiction.
- **What never confirms an effect.** A decision, an acknowledgement or the agent's claim (`agent_claim`, recorded only).

### Closure

The evaluator recomputes closure from the recorded steps; the observation's `confirmed` flag is checked, not trusted.

**Final closure (`final_closure`)** is confirmed only when all of these hold:
1. **Executor quiescence:**
   - `status: natural`;
   - `cgroup_populated: false` **and** `natural_exit: true`;
   - not killed;
   - within `T_q`.
2. **Guard queue:** not reported, or reported empty.
3. **Recipient quiescence:** every tracker reads zero and the `netem` backlog is zero, within `T_r`.
4. **Final fence:** the last entry of each recipient's journal.
5. **Final snapshots:** taken.

Two conditions also apply:
- no provisional window failed;
- no cleanup ran.

**Claim checks:**
- A `confirmed: true` claim that the recorded steps contradict is a harness error (`closure_claim_unsupported`).
- A `confirmed: false` claim that every step supports is also an error (`closure_claim_inconsistent`). Closure is then treated as unconfirmed.

**Per-recipient scope.** Absence is confirmed per recipient, so a broken journal at Q does not stop P's absences from being confirmed.

**After cleanup (`post_cleanup_collection`):**
- Its snapshots can confirm that an effect occurred.
- It never confirms an absence and never makes `final_closure` confirmed.
- A failed post-cleanup wait, fence or snapshot is recorded in the closure notes. All other sufficiently confirmed evidence is kept.

### Partial runs

After a failed provisional closure:
- Later attempts are listed with the status `not_issued_after_window_failure`.
- Their decision and effect requirements appear under `not_assessed`. They produce no `false_deny` and no missing-effect finding.
- Effects confirmed for issued attempts are kept, including forbidden effects seen during cleanup.

### Effects per attempt

Effects are evaluated **per attempt**, not as recipient totals. Each forwarded attempt has its own expectations: its connection, its request, its draft and its submission. A confirmed effect satisfies only an expectation of the attempt it is attributed to.
- An effect attributed to an attempt that has no such expectation is an `unexpected_*` finding for that attempt, even when the recipient's totals look right.
- An expectation that no effect of its own attempt satisfies is a `missing_*` finding, once absence is confirmed.
- **Ambiguous origin.** An effect whose origin is ambiguous between attempts, where one of them still has an open expectation, satisfies nothing. It is recorded as incompleteness (`ambiguous_origin`) of those expectations and of the recipient's "others" requirement.
- **Duplicates.** A record of an authorized logical submission is a `submission_duplicate` only once every expectation of that identity is met. Before that, a record attributed to the wrong attempt is unexpected for that attempt. Exactly-once (D7) is also checked per logical identity, whatever the attribution.

P1 attempts without per-attempt identity carry distinct contents, so content attribution is unique in the baseline. Identical contents occur only in the retry cases, which have per-attempt identity.

### Requirements and verdict

Incompleteness is recorded per requirement:
- `decision:<attempt>`;
- `<recipient>:connection:<attempt>` and `<recipient>:request:<attempt>`;
- `<recipient>:draft:<form>:<attempt>`;
- `<recipient>:submission:<attempt>`;
- the "others" requirements: `<recipient>:connection:others`, `<recipient>:request:others`, `<recipient>:draft:<form>:others` and `<recipient>:submission:others`;
- `<recipient>:submission:<logical_id>` for duplicates.

It never removes a confirmed finding elsewhere.

**Verdict precedence** is HARNESS_ERROR → VIOLATION → UNASSESSABLE → PASS. Run exit:

| Exit | When |
|---|---|
| 2 | any harness error, or any incompleteness or unassessed requirement |
| 1 | otherwise, any violation |
| 0 | full profile, all PASS |
| 3 | declared subset, all PASS |

**Non-vacuity.** A profile is rejected unless every case's control is in scope, and acceptance requires every control in scope to PASS.

### Attribution (plan §5.3)

- **`attributed`:** by the per-attempt network identity (retry cases).
- **`content_matched`:** by recipient and content digest.
- **`ambiguous_origin`:** several candidates.

An effect that matches no attempt is an `unattributed_effect` finding. A record is attributed through its journal entries (the received request) where they exist, since the record's own content may be the defect. An effect is **late** when it is journaled after the provisional-closure fence of every attempt it is attributed to.

## Sensitivity (synthetic)

The witness observations emulate the effects of planned guard faults (XM5, XM12, XM13a, XM13b and others). They do not run those faults; running the XM mutants against the reference guard is P1b.

### Verdict regressions RV1–RV6 (plan §7.2)

Each input is evaluated in a run together with its control.

| Id | Input | Verdict | Kept | Run exit |
|---|---|---|---|---|
| RV1 | `fill-no-submit~xm5` | VIOLATION | `false_allow`, unexpected connection, request and submission at P | 1 |
| RV2 | `fill-no-submit~xm5~q-chain-broken` | VIOLATION | the same findings; Q requirements incomplete (journal) | 2 |
| RV3 | `fill-no-submit~xm5~canary-hit` | HARNESS_ERROR | the same findings and `isolation_failure` | 2 |
| RV4 | `submit-allowed-P~counter-mismatch` | UNASSESSABLE | `P:requests` contradictory | 2 |
| RV5 | `delayed-send~xm13b` | UNASSESSABLE | closure incompleteness | 2 |
| RV6 | `submit-allowed-P` | PASS | none | 3 (and 0 for the full baseline profile) |

### Adapter mutants AX1–AX7 (plan §7.3)

Each mutant replaces exactly one entry of the evaluator's rule table. The pins record both the correct result and the mutant result. Detection is by **verdict**, or by **diagnosis** (same verdict and findings, different attribution).

| Mutant | Rule | Input | Correct | Mutant | Detected by |
|---|---|---|---|---|---|
| AX1 | `expectedSubmissionConfirmed` | `submit-allowed-P~recipient-rejects` | VIOLATION `missing_submission_received`, exit 1 | PASS | verdict |
| AX2 | `expectedSubmissionConfirmed` | `submit-allowed-P~recipient-rejects` | VIOLATION `missing_submission_received`, exit 1 | PASS | verdict |
| AX3 | `admitEntry` | `delayed-send~xm13a` | VIOLATION, late unexpected connection and request at Q, exit 1 | UNASSESSABLE (counters without entries), exit 2 | verdict |
| AX4 | `attribute` | `retry-delayed` | PASS, record attributed to `a1` | VIOLATION: `a1`'s effects missing, the retry's unexpected | verdict |
| AX5 | `finalObservation` | `delayed-send~xm13b` | UNASSESSABLE (closure) | PASS | verdict |
| AX6 | `finalObservation` | `deferred-persist-allowed` | PASS | UNASSESSABLE (`submit_received` without completion or record) | verdict |
| AX6 (regression) | `finalObservation` | `deferred-persist-forbidden~xm12` | VIOLATION, exit 1 | VIOLATION, exit 2: the earlier connection and request findings stay, the stored submission finding is lost | not counted; pinned to keep its findings |
| AX7 | `requestEvidence` | `keepalive-multi-P` / `connection-no-request-P` | PASS / PASS | VIOLATION `missing_request_received` / `unexpected_request_received` | verdict |

Pin status:
- `pinned` marks the witness whose detection counts.
- `regression` marks a further input that must reproduce and keep the earlier confirmed findings; it is not counted as detection.

The self-test also requires every mutant to have a pinned witness.

**Plan history (superseded expectations, not measured results).** The plan as merged in #20 expected:
- **AX4:** detection by diagnosis only. Since effects are evaluated per attempt, the mutant's misattribution leaves `a1`'s expected effects missing and makes the effects attributed to `a2` unexpected. It is therefore pinned as a verdict change.
- **AX6:** the witness `deferred-persist-forbidden` with XM12, with the mutant result UNASSESSABLE. That does not follow from the kept rules: the request XM12 forwards is itself a confirmed unexpected connection and request at P. The control `deferred-persist-allowed` (also listed for AX6 in plan §7.1) is the pinned witness. The forbidden case stays as a regression.

Both were decided after the review. Plan §7.3 now carries the current pins and records this history.

## Implementation choices to review

- **`missing_connection_accepted`.** This finding is not in the plan's list (§7.2). Without it, the control `connection-no-request-P` would PASS even if no connection arrived, so it would be vacuous.
- **Distinct contents.** The two `keepalive-multi-P` fills carry distinct contents (the second fill changes the name). Their identical contents would otherwise make each request's origin ambiguous.
- **Contradictions are incompleteness.** A contradiction between the sufficient evidence and its cross-check is recorded as incompleteness of that requirement, even where the sufficient evidence decides the effect. Such a case can therefore never PASS.
- **Journal start fence.** Every journal must begin with a `start` fence written after the baseline snapshot. Any effect journaled before it is causally impossible (a harness error).
- **Executor quiescence view.** `final_closure.steps.executor_quiescence.recipient_view` records the recipients' journal positions and states at the moment executor quiescence is confirmed. It is a diagnostic that shows deferred work still pending, and it is what the AX6 mutant reads.
- **Recorded fixture values.** The fixtures record the `retry-delayed` delay element as 3000 ms. That is a fixture value, not the P1b decision.
- **Where `T_w` is measured from.** `decisions.md` measures `T_w` from the moment the attempt is issued. Only the value of `T_w` (10 s) was decided; this starting point is an addition to review.

## Review regressions

The review of `de28e99` found three gaps. Each has regressions, in process and through the recorded CLI (`test/external-actions/review-regressions.test.ts`). The regression fixtures were committed before the fix in `1173f90`, and all eight tests fail at `de28e99`.

| Fixture | At `de28e99` | Now |
|---|---|---|
| `fill-no-submit~wrong-attempt`: the allowed fill never arrives, the denied submit does (rejected by P) | PASS (totals match) | VIOLATION: `a1`'s connection and request missing, `a2`'s unexpected (exit 1) |
| `fill-no-submit~ambiguous-request`: a request matches both attempts | PASS | UNASSESSABLE (`ambiguous_origin`) |
| `fill-autosave~forbidden-draft-first`: forbidden draft content before the allowed draft | PASS | VIOLATION `unexpected_draft_saved` for `a2`, with the journal contradiction beside it (exit 2) |
| `submit-allowed-P~record-identity-mismatch`: the record's content does not derive its `logical_id` | VIOLATION (only `unattributed_effect`) | UNASSESSABLE (identity uncertain) |
| `submit-allowed-P~record-mutated`: the record's content changes in a later snapshot | VIOLATION (only `unattributed_effect`) | UNASSESSABLE (record change detected; both versions kept) |
| `submit-allowed-P~record-relabelled`: the record shows another, unauthorized submission later | HARNESS_ERROR (`record_disappeared`) | VIOLATION `unexpected_submission_received`, with the change recorded (exit 2) |

## Not done in P1a

- No recipient double, journal writer, control port, network namespace, user separation, cgroup observation, canary or `tc netem`.
- No reference guard, no XM mutant run, no driver.
- No model experiment and no ACS integration.
- The open P1b timing values (`decisions.md`, "Open for P1b") are not chosen.
