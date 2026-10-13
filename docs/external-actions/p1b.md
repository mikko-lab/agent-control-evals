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
