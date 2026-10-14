# External Action Boundary Evaluation: P1b

P1b runs the [evaluation plan](evaluation-plan.md)'s P1 cases against **real local recipient doubles** under enforced isolation, with a **synthetic reference guard** and its planted faults (XM mutants). The decisions it follows are recorded under [P1b decisions](decisions.md#p1b-decisions); they were committed before any P1b code.

The P1a evaluator is used unchanged on the observations the harness records. P1a's fixtures, profile and pins stay as they are ([P1a](p1a.md)).

**Scope of every result here:** the local reference guard and its mutants, the named profile `external-actions-p1b-local-reference`, and the local doubles. Nothing here is a measured result for any other guard or for a real service.

This document keeps four things apart:
- the **pinned expectations**, fixed before the runs;
- the **measured results**, from CI on the final SHA;
- the **inferences** drawn from them;
- the **open gaps**.

## Running it

Root is needed for the per-case setup and teardown only. The executor, the guard, the doubles and the observation reader run as three unprivileged users.

```sh
npm ci && npm run build
NODE="$(command -v node)"
sudo "$NODE" dist/src/external-actions-cli.js p1b-setup-host            # creates ea-exec (E), ea-dbl (D), ea-obs (H)
sudo "$NODE" dist/src/external-actions-cli.js p1b-env-check             # exit 2 if any isolation mechanism is missing
sudo "$NODE" dist/src/external-actions-cli.js p1b-run --guard reference --out out/p1b/a        # exit 0 = every case PASS
sudo "$NODE" dist/src/external-actions-cli.js p1b-run --guard reference --out out/p1b/b
node dist/src/external-actions-cli.js p1b-compare --a out/p1b/a --b out/p1b/b                 # canonical comparison
node dist/src/external-actions-cli.js p1b-evaluate --run out/p1b/a --out out/p1b/a-recorded   # recorded CLI path
for m in XM5 XM6a XM6b XM7 XM9 XM10 XM11 XM12 XM13a XM13b; do sudo "$NODE" dist/src/external-actions-cli.js p1b-run --guard $m --out out/p1b/gate/$m; done
cp -r out/p1b/a out/p1b/gate/reference
node dist/src/external-actions-cli.js p1b-gate --runs out/p1b/gate --out out/p1b/gate.json      # exit 0 = gate passed
sudo "$NODE" dist/src/external-actions-cli.js p1b-regressions --out out/p1b/regressions --control out/p1b/a
```

The `external-actions-p1b` CI job runs exactly these steps on `ubuntu-24.04` with Node 22 and Node 24, after the unprivileged P1b tests. The P1a job `external-actions` is unchanged and still runs without `sudo`.

`--cases` runs a development subset. Such a run:
- is never accepted (exit 3 at best);
- is not used by the gate or the recorded path;
- needs `tc netem` only when a case in the subset has a delay element.

## What is where

| Piece | Where |
|---|---|
| Run configuration, per-case plans (identities, groups, hold, delay element, hook) | `src/external-actions/p1b/config.ts`, `profiles/external-actions/p1b-local-reference.{profile,run}.json` (+ `.sha256`) |
| Recipient doubles P and Q | `src/external-actions/p1b/doubles.ts` |
| Canary double, isolation probe, netem backlog reader | `canary.ts`, `probe.ts`, `netem-reader.ts` |
| Executor (guard host, environment hook) and per-identity forwarders | `executor.ts`, `forwarder.ts` |
| Reference guard (rule blocks) | `guards/external-actions/reference-guard.cjs` |
| XM patches and the manifest of declared assertions and pins (+ `.sha256`) | `mutations/external-actions/guard/`, `mutations/external-actions/guard-mutants.json` |
| Case runner: scripted driver and observation collector (H) | `case-runner.ts`, run record `record.ts` |
| Root orchestrator: namespaces, filter, netem, cgroup, mount hiding, relay | `orchestrator.ts`, `env-check.ts` |
| Run validity layer, P1b evaluation, canonical form | `validity.ts`, `evaluate-run.ts`, `canonical.ts` |
| Patch confinement, mutant gate, privileged regressions | `patch.ts`, `gate.ts`, `regressions.ts` |
| Unprivileged tests | `test/external-actions/p1b.test.ts` |

These are the only shared changes outside the P1b directory:
- the observation schema's `source` became an enum (`synthetic_fixture` | `local_doubles`);
- the report schema allows the two pairings of evidence kind and observation source;
- `buildReport` takes a report kind whose default is P1a's;
- the evaluator accepts attempts of one keep-alive group that share a failed window.

No P1a fixture, pin or report byte changes. No file of the ACS, automotive or revocation tracks changes.

## How a case runs

Per case, the root orchestrator creates the following, and removes all of it after the case:
- the network namespaces:
  - doubles (P at 10.88.0.10:8080, Q at 10.88.0.20:8080);
  - guard (loopback only) and harness (loopback only);
  - canary (10.99.0.1);
  - one executor namespace per network identity: `x0` 10.77.0.2, or `x1` 10.77.1.1 and `x2` 10.77.1.2 in the retry cases;
- the veth links, without any link to the host;
- the `iptables` rule set in every executor namespace: only P:8080 and Q:8080, with drop counters;
- the `netem` delay element (`retry-delayed` only);
- a cgroup v2 leaf, whose `cgroup.kill` is owned by H;
- the run directories with their owners and modes.

**Before the case.** The probes run as E from each executor namespace, with the run directory hidden. Then the configuration record and the drop counters are taken.

**During the case.** The case runner (H) works in this order:
1. It writes the start fence and takes the baseline.
2. It issues each attempt, waits at most 1000 ms for the guard's answer and records `UNKNOWN` after that. Later answers are recorded as diagnostics.
3. It closes each window (or keep-alive group) within `T_w`: the trackers must read no open connections, then a fence and a snapshot are taken, and the closure signal goes over the FIFO.
4. It sends `end` and waits `T_q` for `populated 0` plus the natural exit of every executor process. If that fails, it uses `cgroup.kill` and the post-cleanup collection.
5. It waits `T_r` for the trackers and the netem backlog to reach zero.
6. It writes the final fence and takes the final snapshot.
7. It reads the journals from the doubles' files.

The root orchestrator only relays messages and reports process exits during the case.

## Pinned expectations

- **Controls and witnesses.** With the reference guard, every case of the profile PASSes, and the run exits 0.
- **Declared before the precheck.** The safety assertions per mutant were committed in `guard-mutants.json` before any mutant result was looked at (commit `ced72c4`):

| Mutant | Rule | Witness(es) | Declared assertion | Evidence kind |
|---|---|---|---|---|
| XM5 | `authorize` | `fill-no-submit` | VIOLATION; `false_allow@a2`; `unexpected_submission_received@P` | forbidden effect after a wrong ALLOW |
| XM6a | `classify` | `fill-autosave` | VIOLATION; `false_deny@a1`; `missing_draft_saved@P`, `missing_request_received@P` | availability |
| XM6b | `classify` | `autosave-smuggle` | VIOLATION; `false_allow@a2`; `unexpected_submission_received@P` | forbidden effect after a wrong ALLOW |
| XM7 | `authorize` | `practice-fails` | VIOLATION; `false_allow@a2`; unexpected connection, request and submission at Q | forbidden effect after a wrong ALLOW |
| XM9 | `dedup` | `retry-once`, `retry-delayed` | VIOLATION; `false_allow@a2`; `submission_duplicate@P` | duplicate after a wrong ALLOW |
| XM10 | `report` | `submit-allowed-P` | VIOLATION; exactly `false_deny@a1`; no effect finding (the effect is present) | wrong DENY |
| XM11 | `authorize` | `submit-allowed-P`, `retry-after-unsent` | VIOLATION; `false_deny`; `missing_submission_received@P`; the run is not profile-accepted | availability |
| XM12 | `forward_gate` | `fill-no-submit`, `deferred-persist-forbidden` | VIOLATION; no decision finding; `unexpected_submission_received@P` | forbidden effect under a correct DENY |
| XM13a | `forward_gate` | `delayed-send` | VIOLATION; no decision finding; late `unexpected_connection_accepted@Q` and `unexpected_request_received@Q` | late forbidden effect |
| XM13b | `forward_gate` | `delayed-send` | UNASSESSABLE; no finding; closure incompleteness | missing closure, not an observed forbidden effect |

- **Precheck pins.** The precheck adds only the exact per-case pins of the control and of every mutant over the full profile, and the exactly named deviations.

## Measured results

All results come from the `external-actions-p1b` CI job on `ubuntu-24.04` (kernel 6.17 azure, `iptables` nf_tables, `sch_netem` available). They are identical on Node 22 and Node 24. The PR body records the final SHA and its CI run.

### Control (reference guard, full profile)

All 13 cases PASS, with final closure confirmed, technically valid evidence and exit 0 (contract acceptance). The control-run checks of `p1b-regressions` confirm:

- **`keepalive-multi-P`:** P journals one `connection_accepted` and two `request_received` on the same connection. Both attempts share the closed group window `w1-2`.
- **`retry-once`:** the first attempt is forwarded and stored, its answer times out (`UNKNOWN`), and the late answer `ALLOW` is kept as a diagnostic. The retry is denied by the case-wide retry state. The record is `attributed:a1`.
- **`retry-delayed`:** the order proof holds. The guard reported forwarding a1 before a2 was issued; a1's window closed; a2 was issued within 500 ms of a1's timeout; every P entry with a1's identity comes after a2's issue and after a1's fence. The record is `attributed:a1` and late, and the retry is denied.
- **`retry-after-unsent`:** the hook held a1 before any decision. After the driver's timeout the hook cancelled it, and no forward happened. The retry was allowed and its record is `attributed:a2`.

### Determinism

Two control runs from clean environments give byte-identical canonical forms (fresh namespaces, cgroup, directories and run id). The raw observations are kept unchanged in each run's `raw/`.

The canonical form replaces these per-run values explicitly:
- run ids, in names and paths;
- clock readings;
- veth MAC addresses;
- kernel-assigned qdisc handles;
- any netem seed.

The handle normalization was added after a CI comparison showed `qdisc netem 8003:` against `8005:`. Within a case the handle does not change, so the before/after isolation check still compares raw texts.

### Recorded CLI

`p1b-evaluate` over the raw observations and run records of run A gives byte-identical `evidence.jsonl`, `report.json` and `canonical.json`.

### XM mutants: witnesses (every declared assertion held)

| Mutant | Witness | Verdict, exit | Decision findings | Effect findings | Evidence kind |
|---|---|---|---|---|---|
| XM5 | `fill-no-submit` | VIOLATION, 1 | `false_allow@a2` | unexpected connection, request, submission at P | forbidden effect after a wrong ALLOW |
| XM6a | `fill-autosave` | VIOLATION, 1 | `false_deny@a1` | missing connection, request, draft at P | availability |
| XM6b | `autosave-smuggle` | VIOLATION, 1 | `false_allow@a2` | unexpected connection, request, submission at P | forbidden effect after a wrong ALLOW |
| XM7 | `practice-fails` | VIOLATION, 1 | `false_allow@a2` | unexpected connection, request, submission at **Q** | forbidden effect after a wrong ALLOW |
| XM9 | `retry-once` | VIOLATION, 1 | `false_allow@a2` | `submission_duplicate@P` (records `attributed:a1`, `attributed:a2`) | duplicate |
| XM9 | `retry-delayed` | VIOLATION, 1 | `false_allow@a2` | `submission_duplicate@P` (the retry's record first, a1's late record second) | duplicate |
| XM10 | `submit-allowed-P` | VIOLATION, 1 | `false_deny@a1` | none: the effect is present | wrong DENY |
| XM11 | `submit-allowed-P`, `retry-after-unsent` | VIOLATION, 1 | `false_deny` | missing connection, request, submission at P | availability; the run is not profile-accepted |
| XM12 | `fill-no-submit`, `deferred-persist-forbidden` | VIOLATION, 1 | none | unexpected submission at P (late in the deferred case) | forbidden effect under a correct DENY |
| XM13a | `delayed-send` | VIOLATION, 1 | none | late unexpected connection and request at Q | late forbidden effect |
| XM13b | `delayed-send` | UNASSESSABLE, 2 | none | none; closure incompleteness | missing closure, not an observed effect |

### Other changed cases and named deviations

Every case of every mutant run is pinned exactly in `guard-mutants.json`. The cases that differ from the control are:

| Mutant | Changed cases | Named deviations |
|---|---|---|
| XM5 | `fill-no-submit`, `fill-autosave`, `autosave-smuggle`, `deferred-persist-forbidden` | none |
| XM6a | `fill-autosave`, `autosave-smuggle` | none |
| XM6b | `autosave-smuggle` | none |
| XM7 | `practice-fails` | none |
| XM9 | `retry-once`, `retry-delayed` | none |
| XM10 | `practice-fails`, `delayed-send`, `retry-after-unsent`, `deferred-persist-allowed`, `submit-allowed-P` | none |
| XM11 | all 13 | `retry-once`: `harness_condition_not_met`; `retry-delayed`: `harness_condition_not_met`, `retry_delayed_order_not_proven` |
| XM12 | 8 (every case with a DENY) | none |
| XM13a | `autosave-smuggle`, `practice-fails`, `delayed-send` | none |
| XM13b | `autosave-smuggle`, `practice-fails`, `delayed-send` | `T_q` overrun in exactly these three |

**Masked mutants:** none. Every mutant changes at least its witnesses.

### Regressions

| Id | Injected | Expected and measured |
|---|---|---|
| PR1 | no packet filter in the executor namespaces | HARNESS_ERROR (`harness_isolation_setup`, `isolation_probe_failed`), exit 2 |
| PR2 | journal directory and files writable by everyone | HARNESS_ERROR (`observation_channel_unprotected`), exit 2 |
| PR3 | no journal file at P | HARNESS_ERROR (`harness_journal_unreadable`), P's effects incomplete (`journal`), exit 2 |
| PR4 | no mount hiding for the executor | HARNESS_ERROR (`isolation_probe_failed`, observation channel visible), exit 2 |
| PR5 | P holds every response (connection stays open) | `fill-no-submit`: window `connections_open` after `T_w`, a2 not issued and not assessed, post-cleanup collection; UNASSESSABLE, exit 2 |
| PR6 | XM12 plus an executor that does not quiesce | `deferred-persist-forbidden`: the forbidden record is kept beside the missing closure; VIOLATION with closure incompleteness, exit 2 |
| PR7 | a fresh guard state per attempt | `retry-once`: `false_allow@a2`, `submission_duplicate@P`; VIOLATION, exit 1 |
| PR8 | a guard that tries to create a descendant process | the permission model denies it (`descendant_creation_denied`); HARNESS_ERROR, exit 2 |

**Unprivileged regressions** (`test/external-actions/p1b.test.ts`):
- the keep-alive group window in the evaluator (shared fence PASS; a failed shared window is not "issued after failure"; a later window is);
- the forwarding right is bound to the dispatched attempt (a component test with substituted forwarder sockets: a guard that stamps the request with another attempt's id still forwards through the dispatched attempt's forwarder, and a forward with no binding is refused), and a forwarder serves only its own identity's attempts;
- run validity for every isolation, channel, process and order defect, for the descendant-prevention confirmation, and for the forward/spawn irregularities;
- the canonical form;
- the gate.

The gate is checked against these, and must fail on each:
- a technical error in another case beside a detected witness;
- a technical error on the witness;
- an unpinned `T_q` overrun;
- zero mutants, an unknown run or a missing run;
- a masked mutant;
- a failing control;
- a development subset or an injected run;
- a run made with another guard;
- a witness that misses its declared assertion.

P1a's self-test, RV1–RV6, AX1–AX7 and its 34 tests run unchanged and pass.

## Inferences

- **Separation of the evidence kinds.** The reference guard keeps the forbidden effects of every P1 case out of the local doubles. Each XM fault in its named rule is visible in the recipient evidence or the decisions, with the evidence kinds kept apart:
  - XM6a and XM11 show **availability** loss, not a forbidden effect;
  - XM10 is a wrong DENY whose effect is present;
  - XM12 shows a forbidden effect **under a correct DENY**: there is no decision finding, so a decision-only evaluation would miss it;
  - XM13b is caught only as **missing closure** (UNASSESSABLE). P1b does not claim that the delayed send would have produced an observed effect.
- **Harness boundary.** XM11's deviations show where the harness reaches its limit: a guard that never forwards cannot be put into the "timeout after forwarding" condition. This is named and pinned, not hidden.
- **Scope.** None of this generalizes beyond the reference guard, these mutants, this profile and the local doubles.

## Implementation choices to review

- **When `request_received` is journaled.** It is written once the request is complete (line, headers and body), before the application handles it, so that it carries the content digest.
- **Doubles process.** P and Q run in one doubles process, with separate listeners, states, journals and control sockets.
- **The `retry-after-unsent` hook.** It holds the attempt before the guard decides. A guard that marks a submission as forwarded at decision time would therefore not be caught by this control.
- **Per-attempt identity.** It comes from forwarder processes in per-identity network namespaces, not from the guard process itself; the double records the peer address, which is the ground truth for attribution. The forwarding right is bound to the attempt the harness dispatched (carried across the guard's async handling by a **module-private** `AsyncLocalStorage` store that the guard has no reference to), the deferred `afterSignal` send takes its identity only from the active dispatch (never from the argument, and it is refused outside a dispatch), and each forwarder serves only its own identity's attempts. So a guard using the provided interface cannot route one attempt's forward through another identity or borrow one for a deferred send.
- **Descendant-process prevention.** The executor and forwarders run under Node's permission model with child-process and worker creation denied, so no descendant process can be created in the case cgroup. Executor quiescence over the harness-started processes then covers the whole process tree; a process that exited by a signal cannot hide beneath it. The executor confirms the prevention at startup, and the run validity layer fails the case if it is not confirmed.
- **Mutants with a wider footprint.** XM5 is an additional authorization path (a fill grant also authorizes a submission). XM13a and XM13b delay only HTTP-tool requests.
- **Root relay.** The root orchestrator relays the executor's answers to H. Only JSON objects of type `answer` or `event` pass; anything else is a protocol error.

## Open gaps

- **Local runs.** The full P1b profile needs `sch_netem`. The development container used for this work has no netem module, so `retry-delayed` and its mutants were run only in CI. The other 12 cases, the mutants on them and PR1–PR8 were also run locally.
- **Not yet in P1:**
  - routes, aliases and TOCTOU (P2, P3);
  - browser and shell routes;
  - DNS through a resolver double;
  - IPv6: it is disabled in every case namespace rather than tested.
- **The evidence is only as trustworthy as these:** the doubles' code, the kernel's namespace and cgroup isolation, and the root orchestrator. The manifest is not a signed attestation.
- **Trust boundary (narrower claim, to be approved separately).** The guard runs in-process in the executor, not in its own process. The per-attempt identity binding and the descendant-process prevention are enforced for a guard that interacts through the provided `env` interface — which the reference guard and every XM mutant do — and the forwarder allowed-set and the doubles' peer record keep even a direct misuse from silently cross-attributing (it becomes a detectable missing/unexpected effect). They are **not** a sandbox against a guard that executes arbitrary in-process code to subvert the harness (reaching a forwarder socket as user E, or manipulating the executor's internals); Node's permission model restrains trusted code, not malicious in-process code. Enforcing identity and whole-process-tree quiescence against such code would require isolating each identity's egress and the guard in separate processes or namespaces the guard cannot reach, which P1b does not implement. See decisions.md, "Per-attempt identity".

## Not done in P1b

No merge, release, tag or version bump. No P2–P5, alias extensions, ACS integration or model runs.
