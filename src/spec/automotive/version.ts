/**
 * Versions of the Automotive Agent Assurance pack (docs/automotive/evaluation-spec.md).
 *
 * These are independent of the ACS v0.1 versions in src/version.ts and must never
 * be replaced by them. Bump the relevant version whenever the corresponding
 * contract changes: a case-shape change MUST bump AUTOMOTIVE_CASE_SCHEMA_VERSION,
 * a reason-class change MUST bump AUTOMOTIVE_REASON_TAXONOMY_VERSION.
 */
export const AUTOMOTIVE_PACK_VERSION = "auto-0.1.0";
export const AUTOMOTIVE_CASE_SCHEMA_VERSION = "auto-case-0.1.0";
export const AUTOMOTIVE_REASON_TAXONOMY_VERSION = "auto-reasons-0.1.0";

/** Expected-truth oracle (src/oracle/automotive/expected.ts). An oracle rule change MUST bump this. */
export const AUTOMOTIVE_ORACLE_VERSION = "auto-oracle-0.1.0";
/** Corpus generator and variant registry. A change in generated corpus bytes MUST bump this. */
export const AUTOMOTIVE_GENERATOR_VERSION = "auto-generator-0.1.0";
/** Harness-owned corpus entry shape (case + expected). */
export const AUTOMOTIVE_CORPUS_ENTRY_VERSION = "auto-corpus-entry-0.1.0";

/** Automotive adapter process protocol (src/adapter/automotive/protocol.ts). Any message or observation shape change MUST bump this. */
export const AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION = "auto-adapter-0.1.0";

/** Deterministic evaluator (src/eval/automotive). A check, matching or verdict rule change MUST bump this. */
export const AUTOMOTIVE_EVALUATOR_VERSION = "auto-evaluator-0.1.0";
/** In-repo deterministic reference agent (src/adapter/automotive-reference). Any behaviour change MUST bump this. */
export const AUTOMOTIVE_REFERENCE_AGENT_VERSION = "auto-reference-agent-0.1.0";

/** Per-case evidence record in evidence.jsonl (src/report/automotive/evidence.ts). Any record shape change MUST bump this. */
export const AUTOMOTIVE_EVIDENCE_VERSION = "auto-evidence-0.1.0";
/** Automotive run manifest (schemas/automotive/manifest.schema.json). Any manifest shape change MUST bump this. */
export const AUTOMOTIVE_MANIFEST_VERSION = "auto-manifest-0.1.0";
/** Automotive report (schemas/automotive/report.schema.json). Any report shape change MUST bump this. */
export const AUTOMOTIVE_REPORT_SCHEMA_VERSION = "auto-report-0.1.0";
