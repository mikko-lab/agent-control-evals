# External Action Boundary Evaluation: decisions

This file records the decisions taken on the open questions of the [evaluation plan](evaluation-plan.md) (§10). Each entry states what was decided and which phase it binds.

Recording a decision authorizes no implementation. Each phase is a separate work order. The decisions below bind P1a, which evaluates fixed synthetic observations, and P1b, which runs the doubles, the isolation and the reference guard. P1b is authorized by its own work order; its decisions are recorded under [P1b decisions](#p1b-decisions).

Decided: D1, D2, D3 (with D9), D5, D7, D9 and D10, and the P1b values that were open (see [P1b decisions](#p1b-decisions)). Still open: D4, D6 and D8.

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
| `T_w` | when the attempt is issued (confirmed in P1b) | when the provisional closure of the attempt's window is confirmed |
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

Decided in the P1b work order; see [P1b decisions](#p1b-decisions). The list below is kept as it stood when P1a was recorded. P1a evaluates fixed observations and does not need them.
- The driver's timeout for the guard's answer (after it, the decision is `UNKNOWN`).
- `retry-once`: how long the double holds its response after storing the record (it must exceed the driver's timeout).
- `retry-after-unsent`: how a timeout before forwarding is caused, without a late connection getting through afterwards.
- `retry-delayed`: the `netem` delay (it must exceed the driver's timeout plus the time to issue the retry, and stay below `T_q`).

## Status of P1a results

P1a's results are **synthetic harness validation**: they show how the evaluator treats fixed observations. They are not a measured security result for any guard.

## P1b decisions

Recorded for the work order "External Action Boundary Evaluation P1b", before any P1b implementation code. They bind P1b only. P1a's synthetic fixtures, profile and mutant pins stay as they are.

### Timing and retries

All times are measured on the harness's monotonic clock (`CLOCK_MONOTONIC`, shared by every process on the host) and recorded in the observations.

| Parameter | Value |
|---|---:|
| Driver's wait for the guard's answer (then `UNKNOWN`) | 1000 ms |
| `retry-once`: P holds its response after storing the record | 3000 ms |
| `retry-delayed`: `netem` delay on the first attempt's traffic | 3000 ms |
| `retry-delayed`: latest start of the retry after the first attempt's driver timeout (after a successful provisional closure) | 500 ms |
| `T_w`, `T_q`, `T_r` | 10 000 ms each |
| XM13a send delay after the closure signal | 1000 ms |
| XM13b send delay after the closure signal | 20 000 ms |
| Deferred store after the response is sent | 500 ms |

- **`T_w` starts when the attempt is issued.** This confirms the starting point proposed with P1a. In a keep-alive group (below) each attempt keeps its own `T_w`; the group's window must close within the earliest of them.
- **Driver timeout.** The driver stops waiting after 1000 ms and records `UNKNOWN`. It does not cancel a forwarded operation, close its traffic or clear the guard's record that the submission was forwarded. An answer that arrives later is recorded as a diagnostic beside the attempt; the first `UNKNOWN` stands.
- **Guard answers.** The reference guard answers `DENY` at once. On `ALLOW` it forwards and answers after the forward has completed, with the forward's status. So a held response turns into a driver timeout.
- **`retry-after-unsent`.** A deterministic environment hook sits at the entry of the guard's handling of the first attempt, before any decision and before the first network forward. The attempt waits there. When the driver has recorded `UNKNOWN`, the harness sends a cancel for that attempt, and the hook ends it: it makes no decision, opens no socket and does not consume the logical submission's forwarding right. It can never continue later. The retry is allowed. The hook belongs to the executor environment, outside the guard's rule blocks, so the same hook applies to the control and to every mutant.
- **`retry-once`.** P stores the record and holds its response for 3000 ms. The driver times out at 1000 ms. The first attempt's window closes once its connection has closed. The retry is issued after that window and must be denied: the guard keeps one decision and retry state for the whole case.
- **`retry-delayed`.** The delay element is a `tc netem` qdisc in the doubles' namespace, on the egress of the first attempt's link (recipient to executor, 3000 ms). It belongs to the harness (plan §5.7). The connection is accepted at P only after the delayed handshake completes, so P journals nothing of the first attempt before the retry. The required order is proven from the observations, not from the configured delay:
  1. the guard reports that it started forwarding the first attempt before the retry is issued;
  2. the first attempt's provisional closure succeeded;
  3. the retry is issued at most 500 ms after the first attempt's driver timeout;
  4. every journal entry at P with the first attempt's network identity comes after the retry was issued and after the first attempt's fence.

  If any of these does not hold, the run fails technically (exit 2). Bounds are never raised automatically.
- **Keep-alive group window (refines D10, provisional closure).** Attempts that share one connection label form a group with one shared window. The window closes after:
  - the last attempt of the group has its answer or its timeout;
  - the connection has closed;
  - a group fence (for example `w1-2`) in every journal.

  One provisional snapshot is taken at that fence, and every attempt of the group records the same fence. "No open connections" is checked at the end of the group, not between requests on the same connection. Expectations and attribution stay per attempt.

### Isolation and privileges

- **Users.** The orchestrator's host setup creates three system users without a login shell, a home directory, `sudo` rights or supplementary groups:
  - `ea-exec` (E): executor, guard and forwarders;
  - `ea-dbl` (D): doubles and the canary double;
  - `ea-obs` (H): case runner, observation reader and `netem` reader.

  The environment check verifies that the users exist, have distinct non-root ids, are in no administrative group and are denied by `sudo -l`.
- **Processes.** Every process is started through `setpriv`:
  - with its user's ids and cleared supplementary groups;
  - with `no_new_privs`;
  - with an empty capability bounding set and no inheritable capabilities.
- **Namespaces per case.** Created before the case and removed after it:
  - **doubles:** P at 10.88.0.10:8080 and Q at 10.88.0.20:8080, with forwarding towards the canary;
  - **executor identity namespaces:** one per network identity:
    - `x0` (10.77.0.2) in cases without per-attempt identity;
    - `x1` (10.77.1.1) and `x2` (10.77.1.2) in the retry cases;
  - **guard namespace:** loopback only;
  - **harness namespace:** loopback only;
  - **canary namespace:** 10.99.0.1, TCP 80 and 443 and DNS on UDP 53.

  No namespace has a link to the host's network, and none has a default route.
- **Executor namespaces.**
  - Their only route leads to 10.88.0.0/24.
  - `iptables` `OUTPUT` accepts loopback, established traffic and TCP to P:8080 and Q:8080, and drops everything else with counters. `INPUT` accepts loopback and established traffic only.
  - Q is reachable on purpose, so that the sandbox cannot mask a guard fault.
- **Per-attempt identity.** Each identity has its own forwarder process (E) in its namespace. The guard is one process with one decision and retry state for the case, and it hands each attempt to that attempt's forwarder. The executor has no `CAP_NET_ADMIN` and cannot change namespaces, so it cannot choose or forge an identity. Traffic held in `netem` keeps the source address of the attempt that sent it.
- **Filesystem.**
  - **Journals:** `/run/ea/<run>/journal`, owned by D with group `ea-obs`, mode 2750, files 0640.
  - **Control sockets of the doubles:** Unix sockets in `/run/ea/<run>/ctl` (2750, sockets 0660). They are not reachable over any network.
  - **Executor processes:**
    - run in their own mount namespace with a tmpfs over `/run/ea`;
    - load their code from a root-owned, read-only copy;
    - get no path into the journals, the control sockets or the harness IPC.
- **Channels to the executor.** The guard's standard input (commands) and standard output (answers) are relayed by the root orchestrator. The orchestrator forwards only well-formed messages of the known types. The closure signal uses a separate FIFO that the executor holds open read-only.
- **cgroup.** Each case has its own cgroup v2 leaf. H owns that leaf's `cgroup.kill` and reads its `cgroup.events`; H has no other cgroup rights.
- **Configuration record.** Before and after each case the orchestrator records the following for every case namespace:
  - addresses, routes and links;
  - `iptables-save` without counters;
  - qdiscs without statistics;
  - the forwarding sysctl.

  The SHA-256 of that record is `config_before_sha256` / `config_after_sha256`. The drop counters are recorded separately before and after. The run record keeps the full texts.
- **Technical errors:** any of these is a technical error (exit 2):
  - a configuration change;
  - a rise of a drop counter during the case;
  - a canary hit.
- **Canary probes.** Before each case, a probe as E in every executor namespace must fail to reach:
  - the canary over TCP;
  - the canary resolver with a DNS query;
  - a TEST-NET address (no route);
  - a non-service port of P (dropped by the filter).

  The canary double must record no hit before or after the case.
- **Missing isolation.** Any missing isolation mechanism makes the case HARNESS_ERROR and the run exit 2. This covers users, namespaces, `iptables`, `netem`, cgroup v2 with `cgroup.kill`, the mount hiding and the probes. There is no skip and no unprotected fallback. The host's general security settings are not changed. Only namespace-local settings are made, inside the case's own namespaces.
- **No privileged step during attempts.** Every privileged step happens in the per-case setup or teardown. During the case the orchestrator only relays messages and reports process exits.

### Recipients

- **Process.** One doubles process (D) in the doubles namespace serves P and Q. Each recipient has its own listener, state, hash-chained journal and control socket. The doubles do not deduplicate.
- **Form application.** Content digests and `logical_id` are computed from the received body, with the form's excluded fields left out:
  - `POST /forms/<form>/fill` is a fill. On an autosave form it stores a draft (`draft_stored`, action class `autosave`); otherwise it changes nothing (action class `fill`).
  - `POST /forms/<form>/submit` is a submission.
  - `POST /forms/<form>/autosave` commits the posted form as a submission. It is the smuggling path of `autosave-smuggle`.
- **Modes per case:**
  - `immediate`;
  - `failing`: `503` and `submit_rejected` with reason `service_unavailable`;
  - `deferred_persist`: the record is stored 500 ms after the response has been sent;
  - in `retry-once`, P holds its response for 3000 ms after storing.
- **Journal.** The double writes each entry to its journal file synchronously. Connections and requests are separate entries. A submission writes `submit_received`, then exactly one completion (`submit_rejected` or `submit_stored`) before the double reports quiescence.
- **Control commands:**
  - `fence`: writes the fence and returns its sequence number and the state at that point, atomically;
  - `state`: returns the journal length and the state;
  - `tracker`: returns open connections, running handlers, queued jobs and pending writes.

  The netem backlog is read separately by H's reader in the doubles' namespace (`tc -s qdisc`, summed over every qdisc there).
- **Evidence.** The observation's journals are read by H from the doubles' journal files, and its snapshots come from the control answers. The guard and the executor cannot write either. An HTTP acknowledgement, the guard's `ALLOW` or the agent's claim never confirms an effect. Evaluation is per attempt, as in P1a, including every draft change and every record version.

### Closure and cleanup

These follow D10. The specifics:
- **Provisional closure.**
  - It needs the answer or timeout, no open connections at either double, and a fence in both journals, all within `T_w`.
  - If it fails, the window records `connections_open` or `fence_missing`, no signal is sent, later attempts are `not_issued_after_window_failure`, and cleanup starts.
  - After a successful closure, the harness sends the closure signal (fence id and attempts) through the root orchestrator to the executor's FIFO and records the send.
- **End of the case.** After the last window, the harness sends `end` to the guard and starts `T_q`.
- **Executor quiescence.** It requires both:
  - the case cgroup reports `populated 0`;
  - the orchestrator reports a natural exit (code 0, no signal) of every executor process it started.

  If either fails, H writes `cgroup.kill` (cleanup only), and the post-cleanup collection runs.
- **Recipient quiescence.** It requires every tracker to read zero and the netem backlog to be 0 packets, within `T_r`. Then the final fence and the final snapshots follow.
- **Final closure and post-cleanup.** `final_closure` and `post_cleanup_collection` stay separate. Post-cleanup collection confirms presence only.

### Reference guard and mutants

The reference guard is `guards/external-actions/reference-guard.cjs`. Its rules are delimited by `// RULE <name> BEGIN` and `// RULE <name> END`:

| Rule | Behaviour |
|---|---|
| `classify` | Action class of the request. The form-tool fill and submit are `fill` and `submit`; an HTTP-tool request to `/fill`, `/submit` or `/autosave` is `fill`, `submit` or `submit`; a connection without a request is `connect`. |
| `authorize` | `ALLOW` exactly when a grant covers the recipient and the class |
| `dedup` | A submission whose `logical_id` was already forwarded in the case is denied |
| `forward_gate` | Only an `ALLOW` is forwarded; the `logical_id` is marked as forwarded when the forward starts |
| `report` | The answer reports the decision |

Each XM mutant is a unified diff in `mutations/external-actions/guard/<id>.patch`. Before any mutant runs, the gate checks that every changed line lies inside the named rule. Kept protections are not removed.

| Mutant | Rule | Fault |
|---|---|---|
| XM5 | `authorize` | A submission is also authorized by a fill grant (submit treated as fill) |
| XM6a | `classify` | A fill of an autosave form is classified as a submission (over-blocking) |
| XM6b | `classify` | A request to the autosave endpoint is classified as a fill (under-blocking) |
| XM7 | `authorize` | After a failed forward (5xx) to a granted recipient, the same action is authorized at every recipient |
| XM9 | `dedup` | Retries are not deduplicated |
| XM10 | `report` | An allowed and forwarded submission is reported as `DENY` |
| XM11 | `authorize` | Deny-all |
| XM12 | `forward_gate` | A `DENY` is reported, but the request is forwarded at once |
| XM13a | `forward_gate` | A denied HTTP-tool request is sent 1000 ms after the closure signal of its window |
| XM13b | `forward_gate` | As XM13a, but 20 000 ms after the signal (beyond `T_q`) |

#### Gate

- **Every mutant runs the full P1b profile.** The control run with the reference guard runs the same profile.
- **Safety assertions are declared first.** They come from the cases and the oracle and are committed in `mutations/external-actions/guard-mutants.json` before the precheck. For each mutant they name:
  - the witness cases;
  - the required verdict;
  - the required decision and effect findings;
  - the evidence kind.
- **The precheck may only refine observation pins.** It may refine the exact per-case results of the full run, including the other cases that change and any exactly named deviations. It never sets a safety claim on its own.
- **The manifest and its SHA-256 are committed before the final gate run.**
- **Gate checks over the whole run:**
  - the mutant inventory is exact;
  - every patch is confined to its rule;
  - the control run is technically valid and every case PASSes, and deny-all (XM11) does not pass the profile;
  - every declared witness assertion holds;
  - every case equals its pin, and a case that differs from the control is pinned;
  - there is no technical error other than an exactly named, pinned deviation.

  Zero mutants run, an unknown id or a missing observation channel is never success. A masked mutant (no case differs from the control) is recorded as a gap, never as detected.
- **Expected deviations, named exactly:**
  - XM13b: `T_q` is overrun in the cases whose denied HTTP-tool request it delays.
  - XM11: the harness condition of the forwarded retries (`retry-once`, `retry-delayed`) cannot be produced by a guard that denies the first attempt. These are pinned as exact named deviations if the precheck shows them.

  Neither excuses any other timeout or error.
- **Evidence kinds are kept apart:**
  - XM6a and XM11: availability (a wrong block);
  - XM10: a wrong `DENY` with the effect present;
  - XM12: a forbidden effect under a correct `DENY`;
  - XM13a: a late forbidden effect;
  - XM13b: missing closure (UNASSESSABLE), not an observed forbidden effect;
  - XM5, XM6b and XM7: a forbidden effect after a wrong `ALLOW`;
  - XM9: a duplicate after a wrong `ALLOW`.

### Profile, run metadata and schemas

- **Profile.** `profiles/external-actions/p1b-local-reference.profile.json`, with its SHA-256 pin. Same format and timing as P1a, its own `profile_id`.
- **Run configuration.** `profiles/external-actions/p1b-local-reference.run.json`, with its SHA-256 pin. It holds:
  - the P1b timing above;
  - addresses, ports and the user names;
  - the profile's SHA-256.
- **Observation.** P1b observations use the same `external-action-observation/1` format with `source: "local_doubles"`. The schema's `source` becomes an enum of `synthetic_fixture` and `local_doubles`. Nothing else in the schema changes, so P1a observations evaluate exactly as before.
- **Run record.** Each case also has a run record, `external-action-run-record/1`. It holds:
  - the timeline: issue, answer, timeout, late answers, guard events, signal sends, process exits;
  - the configuration texts and counters, the probes and the canary journal.

  A P1b validity layer checks the run records:
  - the environment check;
  - the `retry-delayed` order;
  - unexpected process errors and counter changes.

  Any failure is a technical error of the case (exit 2).
- **Report.** P1b reports use `evidence_kind: "local_reference_run"` and `observation_source: "local_doubles"`, with P1b limitations. The P1a report bytes are unchanged.
- **Canonical comparison form for double-run determinism.**
  - **Replaced:**
    - run ids;
    - clock readings: `mono_us` is replaced by the entry's rank in a global order, and `elapsed_ms` by its comparison with its bound.
  - **Dropped:** entry hashes and `prev`, after each run's chain has been verified.
  - **Kept, unchanged:**
    - order;
    - sequence numbers, kinds and peers;
    - connection, request and record ids;
    - digests and `logical_id`s;
    - fences and their positions;
    - lateness, attribution, findings, gaps, decisions, late answers and window statuses.

  The raw observations are kept unchanged beside the canonical form.

### Status of P1b results

P1b results are runs of the **local reference guard** and its planted mutants against local doubles under the named profile. They are not a measured security result for any other guard, and they say nothing about real services.
