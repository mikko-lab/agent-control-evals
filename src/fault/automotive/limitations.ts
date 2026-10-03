/** Limitations embedded in every fault-sensitivity report. The fault summary renders the report's own copy. */
export const AUTOMOTIVE_FAULT_REPORT_LIMITATIONS: readonly string[] = [
  "The faults are deliberately planted synthetic behaviours declared in advance in auto-faults-0.1.0.",
  "The synthetic fault agent is derived from the in-repo deterministic reference agent.",
  "Detecting the declared faults does not imply that every realistic automotive agent fault is detectable.",
  "The fault set and the corpus are not sampled production traffic.",
  "No production failure probability is estimated.",
  "No external automotive AI product is assessed.",
  "Source-code mutation coverage is not measured.",
  "Fault findings depend on the current declared automotive corpus, oracle and evaluator, which may share conceptual blind spots with the human-authored fault set.",
  "The adapter structured-observation fidelity limitation still applies: rendered UI or text is not verified.",
  "This result is not a certification, compliance determination, maturity grade, safety assurance or assurance level.",
];
