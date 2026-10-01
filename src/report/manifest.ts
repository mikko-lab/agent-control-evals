import { execFileSync } from "node:child_process";
import type { GeneratedCorpus } from "../corpus/generate";
import type { SutLock } from "../sut/lock";
import {
  ADAPTER_PROTOCOL_VERSION,
  CASE_SCHEMA_VERSION,
  GENERATOR_VERSION,
  HARNESS_VERSION,
  MUTATION_SET_VERSION,
  ORACLE_SPEC_VERSION,
  REASON_TAXONOMY_VERSION,
  REPORT_SCHEMA_VERSION,
} from "../version";
import { ADAPTER_VERSION } from "../adapter/acs/version";

export interface HarnessGit {
  harness_commit: string;
  harness_worktree_clean: boolean;
}

export function harnessGit(root: string): HarnessGit {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim() !== "";
    return { harness_commit: commit, harness_worktree_clean: !dirty };
  } catch {
    return { harness_commit: "unknown", harness_worktree_clean: false };
  }
}

/**
 * Corpus manifest (work order section 15). The manifest is written next to the
 * corpus and is NOT part of corpus_sha256 (which covers the exact corpus
 * bytes only).
 */
export function buildCorpusManifest(profile: string, seed: string, corpus: GeneratedCorpus, lock: SutLock, git: HarnessGit) {
  const perBoundary: Record<string, number> = {};
  const perFamily: Record<string, number> = {};
  const perVariant: Record<string, number> = {};
  for (const c of corpus.cases) {
    perBoundary[c.evaluation_boundary] = (perBoundary[c.evaluation_boundary] ?? 0) + 1;
    perFamily[c.family] = (perFamily[c.family] ?? 0) + 1;
    const k = `${c.family}/${c.variant}`;
    perVariant[k] = (perVariant[k] ?? 0) + 1;
  }
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return {
    profile,
    generator_version: GENERATOR_VERSION,
    oracle_spec_version: ORACLE_SPEC_VERSION,
    mutation_set_version: MUTATION_SET_VERSION,
    reason_taxonomy_version: REASON_TAXONOMY_VERSION,
    case_schema_version: CASE_SCHEMA_VERSION,
    seed,
    allocation: "equal per family, then equal per variant within family; remainders in declaration order",
    cases: corpus.cases.length,
    cases_per_boundary: sorted(perBoundary),
    cases_per_family: sorted(perFamily),
    cases_per_variant: sorted(perVariant),
    corpus_sha256: corpus.sha256,
    corpus_bytes: Buffer.byteLength(corpus.bytes, "utf8"),
    corpus_format: {
      encoding: "UTF-8",
      line_separator: "LF",
      record_format: "canonical JSON (recursively sorted keys, no whitespace, integers only)",
      order: "generation order: family, then variant, then index within variant",
      final_newline: "exactly one LF after the last record",
    },
    adapter_protocol: ADAPTER_PROTOCOL_VERSION,
    adapter_version: ADAPTER_VERSION,
    sut: lock.sut,
    sut_repository: lock.sut_repository,
    sut_commit: lock.sut_commit,
    sut_version: lock.sut_version,
    harness_version: HARNESS_VERSION,
    harness_commit: git.harness_commit,
    harness_worktree_clean: git.harness_worktree_clean,
    report_schema_version: REPORT_SCHEMA_VERSION,
  };
}
export type CorpusManifest = ReturnType<typeof buildCorpusManifest>;
