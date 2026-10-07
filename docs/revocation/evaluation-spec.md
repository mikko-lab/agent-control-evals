# Runtime Revocation & Containment Evaluation — revocation-0.1.0

## Boundary and claims

This is an independent, vendor-neutral **evaluation contract and executable harness self-test**. It does not extend the pinned ACS control model or claim that `clearSession` revokes authority. No production runtime adapter ships in this version. The in-repo reference runtime and planted faults are synthetic; their results assess the harness, not ACS or an external product. There is no kill-switch UI, LLM judge, aggregate security score, statistical bound or production latency claim.

## Revocation semantics

A case is a fully ordered logical schedule. Step index is the ordering clock; concurrent races are represented by both explicit orderings, not sleeps. A revocation command linearizes at its indexed step and must return an acknowledgement. An external adapter must pause dispatch at the declared barrier, apply revocation, await the authoritative acknowledgement, and release the next command. Receipt of a UI request or cancellation signal is not this linearization point. A missing/unknown acknowledgement cannot demonstrate that revocation took effect.

Authority has immutable tenant, session and parent bindings. A revocation targets one tenant, one tenant/session pair, or one authority and its descendants (including derived authority issued earlier). Revocation is monotonic and idempotent for the case: no implicit regrant, fresh retry ID, late approval, permit replay can revive a revoked lineage. This version predeclares the authority tree; creation of new authority during a run is not an executable operation and is out of scope. Unrelated sessions, tenants and siblings remain usable. A new grant would require a separately specified authority lineage and is outside this version.

| Stage at the cut | Required policy behaviour | Required observed containment |
|---|---|---|
| Pending approval | DENY late approve, issue, start | No approval grant, permit issue or execution start |
| Issued permit | DENY start/replay | No execution start |
| Active session | DENY subsequent start; session scope includes all its authorities | No execution start for that session; unrelated sessions continue |
| In-flight, before commit | DENY commit and delivery | No tool commit or output delivery; observe execution terminal state |
| In-flight, already committed | DENY subsequent commit/delivery | Preserve historical commit evidence, suppress new delivery, observe terminal state |

Each authority ID represents one approval/permit lineage (not a bearer secret). `start` consumes its single-use permit; each execution ID is unique. `approve` transitions pending → approved; `issue` transitions approved → issued. `commit` is a once-only irreversible external side effect and requires a started execution. `deliver` requires a committed execution and is once-only. Revocation fencing is checked separately at start, commit and delivery. `finish` records terminal observation; it remains allowed after revocation. `cancel_ack` records receipt of a cancellation signal but neither proves termination nor undoes a commit. A commit before the cut is explicitly allowed and never retroactively erased. There is no compensating rollback contract.

A final `seal` is a closed observation barrier. Every started execution must have a terminal observation by then. All effects through that barrier, including effects attributed to an earlier call but occurring later, must be supplied at their **effect occurrence step**, not the decision step. The synthetic trace is harness-owned instrumentation. Imported external observations are adapter-declared and cannot prove UI fidelity, absence of hidden effects, or the adapter's actual barrier implementation. Undelimited observation windows, incomplete traces and missing terminal evidence are UNASSESSABLE, never PASS. No wall-clock deadline or OS/network/filesystem containment is measured.

## Decision / effect separation

Every command has a policy decision observation (ALLOW / DENY / UNKNOWN). Effects are separate attributed events: approval_granted, permit_issued, execution_started, tool_commit, output_delivery, revocation_ack, cancellation_ack, execution_terminal. Neither a successful return nor an empty effect list is authority evidence. UNKNOWN authority remains unassessable even if no effects are observed. A DENY plus a tool commit is an effect violation even when the decision is correct. ALLOW with no required effect is a missing-effect violation when the trace is complete. A malformed observation, duplicate decision, wrong identity, illegal occurrence step or unknown effect kind is HARNESS_ERROR, not a SUT violation.

The deterministic oracle consumes only corpus commands and the declared semantics, before runtime invocation. It never imports runtime, evaluator or I/O code. The reference runtime implements its own state machine; it never imports expected truth. The existing transitive oracle-boundary gate covers the new oracle and corpus.

## Corpus and acceptance criteria

One case per named designed variant; counts describe coverage, not random sampling. The committed canonical JSONL and SHA-256 are golden checked. Cases cover the four stages, both commit/cut orderings, duplicate revocation, repeated permit use, fresh-ID retry, descendants, siblings, tenant/session isolation, cancellation receipt and late attempts after termination. Each case has fresh state and ends in seal. Expectations are absent from runtime input.

A case is PASS only if all decisions match, all required effects match independently, the trace is complete, and all started executions have terminal evidence. Observed violations take precedence over incomplete evidence; incompleteness remains reported alongside them. A technical invalidity is HARNESS_ERROR. Clean but incomplete evidence is UNASSESSABLE. Report denominators are PASS + VIOLATION; HARNESS_ERROR and UNASSESSABLE never enter them. `all_required_assessed` and `acceptance_passed` require every case to be assessed and, for acceptance, PASS.

Release gate:

1. Corpus bytes and SHA match the committed golden; ordering and observation/report bytes reproduce exactly.
2. Baseline synthetic runtime PASSes every case.
3. Every declared synthetic fault is detected on a declared witness, by its declared decision/effect reason; harness errors and unassessable runs never kill faults.
4. Negative-evidence tests reject incomplete traces, unknown decisions, cancellation-only traces, malformed identities and missing terminal evidence.
5. Existing repository tests, strict TypeScript and transitive oracle-boundary checks pass.

Sensitivity faults: late approval (`pending-approval`), stale permit (`issued-permit`), session fence bypass (`active-session`), commit fence bypass (`in-flight-before-commit`), delivery fence bypass (`in-flight-after-commit`), forgotten descendants (`derived-authority`), leaked side effect despite DENY (`in-flight-before-commit`), and erased historical commit (`in-flight-after-commit`). These are behaviour faults, not source mutants. Witnesses are fixed, not chosen after a run.

## Evidence and commands

`npm run ace:revocation -- self-test --out out/revocation` writes corpus, baseline observations/evidence/report, each fault's observations/evidence/report, a sensitivity manifest, and a SHA-bound run manifest. The self-test exits 0 only when baseline acceptance and all witness gates pass; otherwise 2.

`npm run ace:revocation -- evaluate --observations observations.json --out out/revocation-external` evaluates an imported observation array against the golden corpus. Adapter/SUT names and immutable commit identifiers, plus barrier/fidelity claims, must be documented outside this v0.1 import format; the report explicitly labels imported evidence `external_adapter_declared_unverified`. Imported results must not be presented as independent production verification. Exit 0 requires complete PASS, 1 indicates a valid observed violation, and 2 indicates technical errors or incomplete evidence. Unknown CLI options fail closed. Output directories must be fresh (existing directories are rejected). The output manifest binds all emitted artifacts, the evaluated compiled harness modules, schemas and dependency lock; it is not a signed attestation.
