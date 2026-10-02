import { STATISTICS_DISCLAIMER } from "../eval/stats";

/** Claims discipline. These sentences are emitted verbatim into every report and summary. */
export const ORACLE_LIMITATION =
  "The generator, oracle specification and mutation set are human-authored and may share conceptual blind spots. The evaluation demonstrates conformance to the declared evaluation specification, not absolute real-world safety.";

export const LIMITATIONS: string[] = [
  ORACLE_LIMITATION,
  "Zero failures means zero observed failures in this evaluated corpus, not zero failure probability.",
  STATISTICS_DISCLAIMER,
  "Statistical unit: confidence bounds are computed only on scenario (case) proportions, with numerators that count members of their denominators. Assertion-level counts are descriptive; assertions within one scenario are dependent and are never treated as independent trials.",
  "Breadth of evidence is the number of designed variants. Cases within one variant are seeded replicates of the same structure, so the case count mostly measures replication; bounds say nothing about situations outside the designed variants.",
  "Mutation sensitivity means the harness detected the defined, deliberately planted faults in the declared mutation set. It does not show that all realistic faults would be detected.",
  "Runtime-boundary and component-boundary results are different levels of evidence. They are reported separately and are never combined into a single security score.",
  "The declared policy parameters (request policy table, ASK approver, timeouts, skew windows, result-withholding rule) were written down by a human from the pinned SUT's documented demo configuration. The oracle does not import SUT code, but a misunderstanding shared by the specification author and the SUT author would not be detected.",
  "The corpus is synthetic and stratified by family and variant. It is not a sample of real agent traffic and says nothing about the frequency of these situations in production.",
  "Results apply only to the pinned SUT commit and the stated harness, corpus and mutation-set versions. They do not transfer to later SUT commits.",
  "Concurrency is exercised by starting several calls on one GuardedExecutor in a single Node.js process without awaiting in between. This covers promise-interleaving at await boundaries, not multi-process or multi-host concurrency.",
  "Tool executions use harness-owned test doubles registered in the SUT process's tool registry for the duration of a case. Real tool behaviour is not evaluated.",
  "Each runtime case uses a frozen injected evaluation clock. Because the pinned SUT stamps its internal result requests with the wall clock, positive scenarios keep clock advances well inside the request skew window (see docs/adapter-protocol-v1.md).",
  "Controls marked N/A (tenant isolation, production latency/throughput) are not measured. They have no pass/fail status, rate, bound or mutation result.",
];
