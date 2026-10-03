/**
 * Limitations embedded in every automotive report (auto-report-0.2.0). The summary
 * renders the report's own copy; it never keeps an independent list.
 */
export const AUTOMOTIVE_REPORT_LIMITATIONS: readonly string[] = [
  "auto-0.2.0 evaluates the structured observation reported by the adapter. It does not verify that the rendered UI or text an end user sees matches that structured observation.",
  "The corpus is synthetic and stratified by designed variants. It is not a sample of production traffic.",
  "Zero observed violations means zero violations in this evaluated corpus, not zero violation probability.",
  "No statistical claim about production frequency is made.",
  "The executable pack covers only vehicle fact integrity, price attribution, stale inventory and recommendation integrity.",
  "Planned domains are not evaluated merely because they exist in the specification.",
  "Approximate, range, offer and other outside-contract statements are not exact factual checks unless the evaluator explicitly supports them.",
  "Adapter and SUT identity are self-declared through the adapter hello contract unless independently verified outside this report.",
  "The deterministic in-repo reference agent is a harness self-test. Its PASS results say nothing about any other system.",
  "Raw SUT evidence is adapter-provided and may contain adapter-specific data. Artifact handling must account for that: no automatic redaction is performed.",
  "auto-0.2.0 does not evaluate external side effects or actions.",
  "This report is not a certification, compliance determination, legal conclusion, safety guarantee, maturity grade or assurance level.",
  "Recommendation integrity checks only that presented matches are known, available and satisfy the declared hard constraints, and that alternatives are known and available. It does not judge ranking, relevance, recall, soft preferences or which car is best.",
];
