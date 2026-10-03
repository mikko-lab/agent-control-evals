/**
 * Automotive run manifest (auto-manifest-0.2.0): reproducibility and identity.
 *
 * Every version is taken from the version constants, every count from the corpus
 * entries, every hash from the exact bytes. Adapter and SUT identity come only from
 * the adapter hello and are labelled self-declared. Harness repository identity is
 * injected by the caller; this module never reads Git, the filesystem or the clock.
 */
import { sha256Hex } from "../../util/hash";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS, type ExecutableAutomotiveDomain } from "../../spec/automotive/domains";
import {
  AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION,
  AUTOMOTIVE_CASE_SCHEMA_VERSION,
  AUTOMOTIVE_CORPUS_ENTRY_VERSION,
  AUTOMOTIVE_EVALUATOR_VERSION,
  AUTOMOTIVE_EVIDENCE_VERSION,
  AUTOMOTIVE_GENERATOR_VERSION,
  AUTOMOTIVE_MANIFEST_VERSION,
  AUTOMOTIVE_ORACLE_VERSION,
  AUTOMOTIVE_PACK_VERSION,
  AUTOMOTIVE_REASON_TAXONOMY_VERSION,
  AUTOMOTIVE_REPORT_SCHEMA_VERSION,
} from "../../spec/automotive/version";
import { AUTOMOTIVE_SMOKE_CORPUS_IDENTITY } from "../../corpus/automotive/profiles";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import type { AutomotiveHelloResponse } from "../../adapter/automotive/protocol";
import {
  AUTOMOTIVE_EVIDENCE_ORDER,
  AUTOMOTIVE_EVIDENCE_RECORD_FORMAT,
  AUTOMOTIVE_EVIDENCE_STATUSES,
  AUTOMOTIVE_IDENTITY_SOURCE,
  AutomotiveReportBuildError,
  type AutomotiveEvidenceRecord,
  type AutomotiveEvidenceStatus,
  type AutomotiveHarnessIdentity,
  type AutomotiveManifest,
} from "./types";

const COMMIT_RE = /^([0-9a-f]{40}|unknown)$/;

export interface AutomotiveManifestInput {
  entries: readonly AutomotiveCorpusEntry[];
  corpusBytes: string;
  evidenceBytes: string;
  records: readonly AutomotiveEvidenceRecord[];
  runValid: boolean;
  hello: AutomotiveHelloResponse | null;
  harnessIdentity: AutomotiveHarnessIdentity;
}

const utf8 = (s: string) => Buffer.from(s, "utf8");

export function buildAutomotiveManifest(i: AutomotiveManifestInput): AutomotiveManifest {
  const h = i.harnessIdentity;
  if (!COMMIT_RE.test(h.commit)) throw new AutomotiveReportBuildError(`harness commit must be 40 hex characters or "unknown", got ${JSON.stringify(h.commit)}`);
  if (typeof h.worktree_clean !== "boolean") throw new AutomotiveReportBuildError("harness worktree_clean must be a boolean");
  if (h.commit === "unknown" && h.worktree_clean) throw new AutomotiveReportBuildError("an unknown harness commit cannot have a known-clean worktree");
  const harness: AutomotiveHarnessIdentity = { commit: h.commit, worktree_clean: h.worktree_clean };
  const perDomain = Object.fromEntries(EXECUTABLE_AUTOMOTIVE_DOMAINS.map((d) => [d, i.entries.filter((e) => e.case.domain === d).length])) as Record<ExecutableAutomotiveDomain, number>;
  const statuses = Object.fromEntries(AUTOMOTIVE_EVIDENCE_STATUSES.map((s) => [s, i.records.filter((r) => r.status === s).length])) as Record<AutomotiveEvidenceStatus, number>;
  const corpus = utf8(i.corpusBytes);
  const evidence = utf8(i.evidenceBytes);
  return {
    manifest_version: AUTOMOTIVE_MANIFEST_VERSION,
    pack: {
      pack_version: AUTOMOTIVE_PACK_VERSION,
      case_schema_version: AUTOMOTIVE_CASE_SCHEMA_VERSION,
      reason_taxonomy_version: AUTOMOTIVE_REASON_TAXONOMY_VERSION,
      oracle_version: AUTOMOTIVE_ORACLE_VERSION,
      generator_version: AUTOMOTIVE_GENERATOR_VERSION,
      corpus_entry_version: AUTOMOTIVE_CORPUS_ENTRY_VERSION,
      adapter_protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION,
      evaluator_version: AUTOMOTIVE_EVALUATOR_VERSION,
      report_schema_version: AUTOMOTIVE_REPORT_SCHEMA_VERSION,
    },
    corpus: {
      ...AUTOMOTIVE_SMOKE_CORPUS_IDENTITY,
      sha256: sha256Hex(corpus),
      bytes: corpus.length,
      cases: i.entries.length,
      variants: new Set(i.entries.map((e) => `${e.case.domain}/${e.case.variant}`)).size,
      cases_per_domain: perDomain,
    },
    evaluation: { evaluator_version: AUTOMOTIVE_EVALUATOR_VERSION, run_valid: i.runValid, case_statuses: statuses },
    evidence: {
      evidence_version: AUTOMOTIVE_EVIDENCE_VERSION,
      sha256: sha256Hex(evidence),
      bytes: evidence.length,
      records: i.records.length,
      record_format: AUTOMOTIVE_EVIDENCE_RECORD_FORMAT,
      order: AUTOMOTIVE_EVIDENCE_ORDER,
    },
    harness,
    adapter: i.hello ? { name: i.hello.adapter, version: i.hello.adapter_version, protocol_version: i.hello.protocol_version, identity_source: AUTOMOTIVE_IDENTITY_SOURCE } : null,
    sut: i.hello ? { name: i.hello.sut.name, version: i.hello.sut.version, revision: i.hello.sut.revision, identity_source: AUTOMOTIVE_IDENTITY_SOURCE } : null,
  };
}
