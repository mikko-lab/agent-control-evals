# P2 review and evidence boundary

Review recorded 2026-11-17: **AI-assisted review in this conversation**, as reported by the requester. The earlier matrix-gate findings are closed. This is not an audit by an external organization, a certification, or a production-security guarantee. Authorization currently covers local commit/PR preparation only.

## Four separate evidence levels

1. **Components:** actual parser, routing, guard and transport checks with synthetic effect projection; 16 cases and seven allowed controls. These are not independent recipient observations.
2. **Linux live:** recipient-owned P/Q journals in the separately defined synthetic network, including resolver/proxy attribution and bounded closure. Five named guard mutants on two Node versions, ten mutant runs total, plus five technical fault experiments. The collector, service code, OS and execution environment remain trusted.
3. **Matrix gate:** complete unique inventory, exact technical failure causes without arbitrary collateral errors, original-report replay, deterministic re-evaluation and cross-version semantic equality. The accepted 21-row evidence is **20 historical runs + one new channel-writable run**. Two additional new reference runs are separate regression evidence. The old channel run is still correctly rejected for missing structured diagnostics.
4. **Repository/CI:** 35 local skips remain: seven pinned revocation-runtime tests and 28 external ACS/SUT tests. Their 50-file local import closure and named configurations match the base HEAD. They are not passes and do not block the scoped P2 matrix gate; the external runtime jobs and remote CI have not been verified for this change.

Historical reports retain `p2_acceptance: false`. This new review record does not rewrite them, grant merge permission, or turn `matrix_gate_passed` into overall P2 acceptance.

See the [portable evidence summary](p2-evidence-summary.json), [evidence access and rebinding instructions](p2-evidence-access.md), [usage](p2.md) and [topology/trust boundaries](p2-live-design.md).

## Later CI expectations

The existing [ci workflow](../../.github/workflows/ci.yml) runs on push and pull_request, with Node 22/24 jobs for harness smoke, automotive, revocation containment, P1a, pinned revocation runtime, runtime-own gates and privileged P1b. The normal unit-test glob already includes all P2 component/live-evaluator/matrix tests; their inputs are synthetic tests, not new live network evidence.

Harness smoke prepares the pinned ACS checkout/build and runs real adapter integration/schema tests in step 11. The revocation-runtime job prepares its pinned runtime, runs seven runtime tests, and explicitly requires zero skips/failures. The P1b job does not establish P2 resolver/proxy topology evidence. There is currently no P2 privileged live-matrix CI job: those results remain separately retained local evidence. The [full benchmark](../../.github/workflows/full-benchmark.yml) is manual-only and is not dispatched here.

A later authorized push/PR can automatically start normal CI. Review its results against the exact new commit SHA before any merge decision. No workflow changes or dispatches are part of this preparation.
