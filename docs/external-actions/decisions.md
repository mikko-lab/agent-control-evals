# External Action Boundary Evaluation: decisions

This file records the decisions taken on the open questions of the [evaluation plan](evaluation-plan.md) (§10). Each entry states what was decided and which phase it binds.

Recording a decision authorizes no implementation. Each phase is a separate work order. The decisions below bind P1a, which evaluates fixed synthetic observations, and P1b, which runs the doubles, the isolation and the reference guard. P1b is **not** authorized by this file.

Decided: D1, D2, D3 (with D9), D5, D7, D9 and D10. Still open: D4, D6 and D8, and the P1b timing values listed under [Open for P1b](#open-for-p1b).

## D1: Guard SUT

The first guard under evaluation is a **synthetic reference guard in this repository**, with the planted faults of §7.3 (XM mutants).

- P1 shows that the evaluation harness works. It makes no claim about any real guard.
- The ACS runtime (`acs-guardrail-demo`) is not changed. A pinned guard behind an adapter is phase P4. Third-party guards are a later phase as well.
- Running the reference guard and its XM mutants belongs to P1b. P1a has no guard: it evaluates fixed synthetic observations only.

## D2: Autosave

Whether `draft_saved` is allowed is **pinned per case**, in the case definition (the form's `autosave` flag together with the case's authorization).

- `keepalive-multi-P` runs with autosave **off**, so it counts connections and requests without a draft change.
- No P1 case allows any effect at Q, so no draft is ever allowed at Q in P1.

## D3 (with D9): Effect classes

The effects at a recipient are `connection_accepted`, `request_received`, `draft_saved`, `submission_received` (stored) and `submission_duplicate`.

- A submission attempt's journal events `submit_received`, `submit_rejected` and `submit_stored` are evidence about a submission. They are not further effect classes.
- `forwarded` describes what the guard did. It is guard behaviour, not an effect at the recipient.

## D5: Sandbox mechanism and CI

**P1a** runs without privileges. Its evaluator over recorded observations, the verdict regressions RV1–RV6 and the adapter mutants AX1–AX7 run in CI on Node 22 and Node 24 without `sudo`.

**P1b** (future phase, recorded here as decided; not authorized):
- Isolation uses Linux network and mount namespaces, separate OS users (`E` executor, `D` doubles, `H` harness reader) and cgroup v2 observation of the executor.
- The isolated runs are separate `ubuntu-24.04` CI jobs on Node 22 and Node 24. GitHub's Linux runners document passwordless `sudo`. Whether namespaces and cgroups actually work on the runner must be shown by an environment check before any case runs.
- `sudo` is used only to set up and tear down the environment. The executor and the guard run without elevated privileges.
- Missing isolation is a technical failure (exit 2). There is no skip and no unprotected fallback. The host's general security settings (for example the AppArmor restriction on unprivileged user namespaces) are not weakened.

**Per-case privileges (P1b):**
- The per-attempt child network namespaces and the `tc netem` rules are created before a case starts and removed after it ends. In the deterministic track the number of attempts per case is known in advance, so no privileged step runs during the attempts.
- `E` has no `sudo` and no administrative rights.
- `H`'s rights are limited to the cgroup of the run in question: observing it, and `cgroup.kill` for cleanup.

## D7: Logical submission identity and retries

The proposal of plan §5.7 is accepted:
- `logical_id = sha256(form_id ‖ canonical digest of the submitted user fields)`, computed by the double. Fields that legitimately differ between attempts (session and CSRF tokens, client timestamps) are excluded, as each form definition lists. An idempotency key is recorded but is not part of `logical_id`.
- The doubles do **not** deduplicate.
- **Exactly once at the recipient**: at final closure, exactly one record with the authorized `logical_id` (zero is `missing_submission_received`, two or more is `submission_duplicate`) and no record with any other `logical_id` (each is `unexpected_submission_received`).
- The retry decisions of §5.7 apply. P1 includes all three retry cases: `retry-once`, `retry-delayed` and the control `retry-after-unsent`.

## D9: Effect evidence

The per-effect-class evidence rules of plan §5.5 are accepted, including the classification of submission attempts (received, rejected, stored) at final closure.

The doubles' application state, as captured in each state snapshot, consists of:
- the connection counter and the request counter;
- the draft records;
- the submission records.

## D10: Closure, bounds and identity

### Bounds

| Parameter | Value |
|---|---:|
| `T_w` (provisional window closure) | 10 s |
| `T_q` (executor quiescence) | 10 s |
| `T_r` (recipient quiescence) | 10 s |
| XM13a send delay | 1 s |
| XM13b send delay | 20 s |
| Deferred persistence delay | 0.5 s |

The bounds are pinned in the profile and recorded in every observation. A bound is never extended automatically after a failed run. Double-run determinism checks reproducibility; it does not by itself show that the bounds are sufficient.

### Where each interval is measured from

All intervals are measured on the harness's monotonic clock.

| Interval | Starts | Ends |
|---|---|---|
| `T_w` | when the attempt is issued | when the provisional closure of the attempt's window is confirmed |
| `T_q` | when the fence of the last attempt's provisional closure has been written | when the executor's cgroup reports `populated 0` **and** every process is confirmed to have exited naturally |
| `T_r` | when executor quiescence is confirmed | when every double's work tracker reads zero and the harness's `tc netem` queues are empty |
| XM13a / XM13b delay | when the mutant guard receives the closure signal for its window | when the mutant starts the send |
| Deferred persistence | when the double has sent its response | when the double writes the record |

### Executor quiescence

`T_q` ends only when both hold:
- the executor's cgroup reports `populated 0`;
- every process has exited naturally. An empty cgroup alone is not enough.

### Provisional closure and its bound

- A provisional closure needs the guard's answer (or its timeout), no open connections at the doubles and a fence in every journal (plan §5.4).
- The wait for it is bounded by `T_w`. If the fence is not obtained or connections stay open, the wait ends, the failure and its reason are recorded, and cleanup starts. The run never waits indefinitely for `T_q` to start.
- After a failed provisional closure, later attempts are not issued. They remain in the case's attempt list with the status `not_issued_after_window_failure`:
  - they produce no `false_deny` and no missing-effect finding;
  - their requirements are not assessed;
  - findings confirmed for attempts already issued, and forbidden effects observed during cleanup, are kept.
- After a failed provisional closure, final closure cannot be confirmed.

### Closure signal

- XM13a's send starts only after the closure signal of its window, so lateness does not depend on the speed of the machine.
- The signal goes over a one-way channel that the executor can only read, for example a pipe. It carries no journal or snapshot content and gives no route into the harness namespace.
- The control and every mutant receive the same signal. Each signal sent is recorded in the observation.

### Recipient quiescence and `tc netem`

The harness's `tc netem` queues are part of the closure tracking. Their backlog is checked in step 3 (recipient quiescence), before the final fence: packets can remain queued after the process that sent them has exited.

### Final closure and cleanup are recorded separately

- **`final_closure`** records the state and failure reason of each of the five steps of plan §5.4. It is confirmed only when every required observation agrees and no cleanup was needed. The evaluator checks the fields that support the claim; `confirmed: true` alone is not enough.
- **`post_cleanup_collection`** records, each with its own status, the steps after cleanup:
  - the wait for recipient quiescence, bounded by `T_r`;
  - the fence;
  - the snapshots.

  It can confirm that an effect occurred. It never confirms the absence of an effect, and it never makes `final_closure.confirmed` true.

### Cleanup

- `cgroup.kill` is cleanup after a bound has expired. It never confirms natural quiescence.
- The run keeps the missing closure and any confirmed findings.
- If the wait for the recipients, the fence or the snapshots fail during cleanup, the gap is recorded and all other sufficiently confirmed evidence is kept.

### Per-attempt network identity

Per-attempt identity is provided by **a child network namespace per attempt**, with one address assigned by the harness. Conditions:
- the executor cannot change or forge its network identity;
- delayed traffic keeps the identity of the attempt that started it;
- the guard uses one decision state per case. Attempts never get new, mutually independent deduplication states;
- `tc netem` is under the harness's control, and its queues are part of closure tracking.

Per-attempt identity is required in the retry cases. Every other P1 case reports `content_matched` attribution, and the report states the level.

## Open for P1b

These are decided in the P1b work order. P1a evaluates fixed observations and does not need them.
- The driver's timeout for the guard's answer (after it, the decision is `UNKNOWN`).
- `retry-once`: how long the double holds its response after storing the record (it must exceed the driver's timeout).
- `retry-after-unsent`: how a timeout before forwarding is caused, without a late connection getting through afterwards.
- `retry-delayed`: the `netem` delay (it must exceed the driver's timeout plus the time to issue the retry, and stay below `T_q`).

## Status of P1a results

P1a's results are **synthetic harness validation**: they show how the evaluator treats fixed observations. They are not a measured security result for any guard.
