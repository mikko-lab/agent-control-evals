/**
 * The committed capability profile and runtime-specific supplement of the revocation track, loaded and checked fail
 * closed before any runtime is invoked or any observation is read (docs/revocation/runtime-adapter-compatibility.md,
 * sections 2.2, 6 and 7).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../util/canonical-json";
import { expected } from "../../oracle/revocation/expected";
import type { Authority, Case, Expected, Family, Step } from "../../spec/revocation/model";
import type { AdapterCase, DoubleVariant } from "../../adapter/revocation-runtime/runner";
import { Applicability, classify, OutOfScopeRequirement } from "./classifier";

export interface ProfileCase {
  id: string;
  family: Family;
  applicability: Applicability;
  not_assessed_requirements: number[];
  out_of_scope?: OutOfScopeRequirement[];
  tested_property?: string;
  family_caveat?: string;
}
export interface Profile {
  profile: string;
  contract: string;
  corpus_sha256: string;
  sut_lock: { file: string; sut_commit: string };
  control_ops: string[];
  uncovered_design_fences: string[];
  barrier_watchdog_ms: number;
  cases: ProfileCase[];
}
export interface ExpectedResult { verdict: string; decision_findings: { reason: string; step: number }[]; effect_findings: { reason: string; step: number }[]; incomplete: string[]; errors: string[] }
export interface SupplementCase extends AdapterCase {
  family: Family;
  authorities: Authority[];
  steps: Step[];
  double: DoubleVariant;
  expectation_source: "contract_oracle" | "runtime_specific";
  runtime_specific_reason?: string;
  purpose: string;
  expected: Expected;
  expected_result: ExpectedResult;
  declared_incomplete?: string[];
}
export interface Supplement { supplement: string; contract: string; sut_lock: { file: string; sut_commit: string }; cases: SupplementCase[] }

export class ProfileError extends Error {}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Loads a committed JSON file and checks its bytes against the committed golden <name>.sha256. */
function golden(root: string, path: string): { value: unknown; sha256: string } {
  const bytes = readFileSync(join(root, path));
  const want = readFileSync(join(root, path.replace(/\.json$/, ".sha256")), "utf8").trim();
  const got = sha256(bytes);
  if (got !== want) throw new ProfileError(`${path}: SHA-256 ${got} != committed golden ${want}`);
  return { value: JSON.parse(bytes.toString("utf8")), sha256: got };
}

export const controlSteps = (c: { steps: Step[] }) => c.steps.flatMap((s, i) => (s.op === "finish" || s.op === "seal" ? [i] : []));

export function loadProfile(root: string, path: string, corpus: Case[], corpusSha256: string, contract: string, sutCommit: string): { profile: Profile; sha256: string } {
  const { value, sha256: digest } = golden(root, path);
  const p = value as Profile;
  const fail = (m: string): never => { throw new ProfileError(`${path}: ${m}`); };
  if (p.contract !== contract) fail(`contract ${p.contract} != ${contract}`);
  if (p.sut_lock?.sut_commit !== sutCommit) fail(`sut_commit ${p.sut_lock?.sut_commit} != lock ${sutCommit}`);
  if (p.corpus_sha256 !== corpusSha256) fail("corpus SHA-256 differs from the golden corpus");
  if (canonicalJson(p.control_ops) !== canonicalJson(["finish", "seal"])) fail("control_ops must be finish and seal");
  if (!Number.isSafeInteger(p.barrier_watchdog_ms) || p.barrier_watchdog_ms <= 0) fail("barrier_watchdog_ms must be a positive integer");
  if (p.cases.length !== corpus.length || p.cases.some((x, i) => x.id !== corpus[i].id)) fail("cases must list every corpus case in corpus order");
  // Applicability is the classifier's, computed from the corpus and the oracle only.
  corpus.forEach((c, i) => {
    const want = classify(c, expected(c));
    const have = p.cases[i];
    const got = { id: have.id, applicability: have.applicability, out_of_scope: have.out_of_scope ?? [], not_assessed_requirements: have.not_assessed_requirements };
    if (canonicalJson(got) !== canonicalJson(want)) fail(`case ${c.id}: committed applicability differs from the classifier`);
    if (have.family !== c.family) fail(`case ${c.id}: family differs from the corpus`);
    if (have.applicability === "IN_PROFILE" && !have.tested_property) fail(`case ${c.id}: IN_PROFILE case without tested_property`);
  });
  return { profile: p, sha256: digest };
}

export function loadSupplement(root: string, path: string, contract: string, sutCommit: string): { supplement: Supplement; sha256: string } {
  const { value, sha256: digest } = golden(root, path);
  const s = value as Supplement;
  const fail = (m: string): never => { throw new ProfileError(`${path}: ${m}`); };
  if (s.contract !== contract) fail(`contract ${s.contract} != ${contract}`);
  if (s.sut_lock?.sut_commit !== sutCommit) fail(`sut_commit ${s.sut_lock?.sut_commit} != lock ${sutCommit}`);
  if (new Set(s.cases.map((c) => c.id)).size !== s.cases.length) fail("duplicate supplement case id");
  for (const c of s.cases) {
    if (c.expectation_source === "contract_oracle") {
      const want = expected({ id: c.id, family: c.family, authorities: c.authorities, steps: c.steps });
      if (canonicalJson(want) !== canonicalJson(c.expected)) fail(`case ${c.id}: committed expectations differ from the contract oracle`);
    } else if (c.expectation_source !== "runtime_specific" || !c.runtime_specific_reason) fail(`case ${c.id}: a runtime-specific expectation needs its reason`);
    const declared = c.declared_incomplete ?? [];
    if (canonicalJson([...declared].sort()) !== canonicalJson([...c.expected_result.incomplete].sort())) fail(`case ${c.id}: declared_incomplete must equal the expected incompleteness`);
  }
  return { supplement: s, sha256: digest };
}
