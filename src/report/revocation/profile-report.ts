import { canonicalJson } from '../../util/canonical-json';
import { Case, Evidence, Expected, VERSION } from '../../spec/revocation/model';
import type { Profile, SupplementCase } from '../../profile/revocation/profile';
import { renderCut } from './report';

/**
 * Declared-profile report of a pinned runtime adapter run (docs/revocation/runtime-adapter-compatibility.md, sections
 * 2.4-2.5 and 6). All 27 corpus cases are listed; verdicts exist only for IN_PROFILE cases; finish/seal decisions are
 * counted as not assessed; the supplement is reported apart from corpus coverage and the profile pass rate.
 */
export const PROFILE_LIMITATIONS = [
  'Declared-profile result: OUT_OF_SCOPE cases have no verdict, and finish/seal decisions (harness control) are not assessed. This is never a revocation-0.4.0 contract pass.',
  'The adapter evaluates one pinned runtime commit in process; terminal timing in the profile is chosen by the harness (registered-work construction) and shows observation and recording, not that the runtime stops work.',
  'Not a production revocation-latency claim. Logical schedule ordering only.',
  'The audit stream is the runtime\'s own report and is not evidence for any decision or effect.',
  'Supplement expectations marked runtime_specific are not contract expectations.',
  'Effects are derived from full-state probes; order within a step is established only by probe-bound seq.',
  'Designed synthetic coverage, not statistical sampling; corpus, oracle, profile and faults are human-authored and may share blind spots.',
];
export interface SutBlock { repository: string; commit: string; tree: string; version: string; lock_sha256: string; build_sha256: string; baseline_verified: boolean }
export interface SupplementEntry {
  case_id: string; purpose: string; expectation_source: string; runtime_specific_reason?: string;
  expected_result: SupplementCase['expected_result']; declared_incomplete: string[];
  evidence: Evidence; matches_declaration: boolean; mismatches: string[];
}

const fsort = (xs: { reason: string; step: number }[]) => xs.map(x => `${x.reason}@${x.step}`).sort();

/** Exact comparison of a supplement case's evidence with its committed declaration. */
export function compareDeclaration(s: SupplementCase, e: Evidence): string[] {
  const m: string[] = [];
  const x = s.expected_result;
  if (e.verdict !== x.verdict) m.push(`verdict ${e.verdict} != declared ${x.verdict}`);
  if (canonicalJson(fsort(e.decision_findings)) !== canonicalJson(fsort(x.decision_findings))) m.push(`decision findings ${fsort(e.decision_findings).join(',') || 'none'} != declared ${fsort(x.decision_findings).join(',') || 'none'}`);
  if (canonicalJson(fsort(e.effect_findings)) !== canonicalJson(fsort(x.effect_findings))) m.push(`effect findings ${fsort(e.effect_findings).join(',') || 'none'} != declared ${fsort(x.effect_findings).join(',') || 'none'}`);
  if (canonicalJson([...e.incomplete].sort()) !== canonicalJson([...x.incomplete].sort())) m.push(`incomplete ${JSON.stringify(e.incomplete)} != declared ${JSON.stringify(x.incomplete)}`);
  if (canonicalJson(e.errors.map(r => r.code).sort()) !== canonicalJson([...x.errors].sort())) m.push(`errors ${e.errors.map(r => r.code).join(',') || 'none'} != declared ${x.errors.join(',') || 'none'}`);
  return m;
}

/** A supplement case is technically valid when it has no error and no incompleteness beyond its declaration. */
const supplementValid = (s: SupplementCase, e: Evidence) => e.errors.length === 0 && e.incomplete.every(i => (s.declared_incomplete ?? []).includes(i));

export function buildProfileReport(input: {
  corpus: Case[]; truths: Expected[]; corpus_sha256: string;
  profile: Profile; profile_sha256: string; supplement_id: string; supplement_sha256: string;
  evidence: Map<string, Evidence>; supplement: { c: SupplementCase; e: Evidence }[];
  sut: SutBlock; harness_commit: string | null; harness_worktree_clean: boolean;
}) {
  const { profile } = input;
  const evidence = input.corpus.map((c, i) => {
    const p = profile.cases[i];
    const common = { applicability: p.applicability, not_assessed_requirements: p.not_assessed_requirements };
    if (p.applicability === 'OUT_OF_SCOPE') {
      return { case_id: c.id, family: c.family, state_at_cut: input.truths[i].cuts, verdict: null, confirmed_violation: false, decision_findings: [], effect_findings: [], incomplete: [], errors: [], ...common, out_of_scope: p.out_of_scope ?? [] };
    }
    const e = input.evidence.get(c.id);
    if (!e) throw new Error(`no evidence for IN_PROFILE case ${c.id}`);
    return { ...e, ...common, tested_property: p.tested_property!, ...(p.family_caveat ? { family_caveat: p.family_caveat } : {}) };
  });
  const inProfile = evidence.filter(e => e.applicability === 'IN_PROFILE') as (Evidence & { not_assessed_requirements: number[] })[];
  const counts = {
    corpus_total: evidence.length, in_profile: inProfile.length, out_of_scope: evidence.length - inProfile.length,
    not_assessed_requirements: inProfile.reduce((n, e) => n + e.not_assessed_requirements.length, 0),
    PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, assessed: 0, confirmed_violation_cases: 0,
  };
  for (const e of inProfile) { counts[e.verdict]++; if (e.confirmed_violation) counts.confirmed_violation_cases++; }
  counts.assessed = counts.PASS + counts.VIOLATION;
  const corpusValid = inProfile.every(e => e.errors.length === 0 && e.incomplete.length === 0);
  const supplement: SupplementEntry[] = input.supplement.map(({ c, e }) => {
    const mismatches = compareDeclaration(c, e);
    return {
      case_id: c.id, purpose: c.purpose, expectation_source: c.expectation_source, ...(c.runtime_specific_reason ? { runtime_specific_reason: c.runtime_specific_reason } : {}),
      expected_result: c.expected_result, declared_incomplete: c.declared_incomplete ?? [], evidence: e, matches_declaration: mismatches.length === 0, mismatches,
    };
  });
  const supplementTechnicallyValid = input.supplement.every(({ c, e }) => supplementValid(c, e));
  const supplementCounts = { total: supplement.length, matching: supplement.filter(s => s.matches_declaration).length, confirmed_violation_cases: supplement.filter(s => s.evidence.confirmed_violation).length };
  const technically_valid = corpusValid && supplementTechnicallyValid;
  const has_confirmed_violation = counts.confirmed_violation_cases > 0 || supplementCounts.confirmed_violation_cases > 0;
  const profile_acceptance_passed = counts.in_profile > 0 && counts.PASS === counts.in_profile && corpusValid;
  const supplement_acceptance_passed = supplementCounts.matching === supplementCounts.total;
  // Every requirement of every case assessed and passed: impossible while any case is OUT_OF_SCOPE or any K decision is skipped.
  const contract_acceptance_passed = counts.out_of_scope === 0 && counts.not_assessed_requirements === 0 && counts.PASS === counts.corpus_total && technically_valid;
  const statement = `Declared-profile result for ${profile.profile} on acs-guardrail-demo@${input.sut.commit}: ${counts.in_profile} of ${counts.corpus_total} corpus cases in profile, PASS ${counts.PASS} of ${counts.in_profile}; ${counts.not_assessed_requirements} requirements (finish/seal decisions) not assessed. This is not a ${VERSION} contract pass. Supplement: ${supplementCounts.matching} of ${supplementCounts.total} runtime-specific checks as declared (reported separately; not part of corpus coverage).`;
  return {
    version: VERSION, mode: 'declared_profile' as const, observation_source: 'pinned_runtime_adapter' as const, corpus_sha256: input.corpus_sha256,
    sut: input.sut, profile: { id: profile.profile, sha256: input.profile_sha256 }, supplement_file: { id: input.supplement_id, sha256: input.supplement_sha256 }, harness_commit: input.harness_commit, harness_worktree_clean: input.harness_worktree_clean,
    counts,
    corpus_coverage: { in_profile: counts.in_profile, total: counts.corpus_total },
    profile_pass_rate: { pass: counts.PASS, in_profile: counts.in_profile },
    technically_valid, has_confirmed_violation, contract_acceptance_passed, profile_acceptance_passed, supplement_acceptance_passed,
    statement, uncovered_design_fences: profile.uncovered_design_fences, limitations: PROFILE_LIMITATIONS,
    evidence,
    supplement: { counts: supplementCounts, technically_valid: supplementTechnicallyValid, cases: supplement },
  };
}
export type ProfileReport = ReturnType<typeof buildProfileReport>;

/**
 * Exit codes (section 2.5, with the binding clarifications of the integration work order):
 *  2 not technically valid: any error, any corpus incompleteness (whatever the verdict), any supplement error or
 *    incompleteness beyond its declaration; also when confirmed violations were retained;
 *  1 technically valid with a confirmed finding (corpus or supplement);
 *  3 declared profile accepted and supplement exactly as declared; never a contract pass;
 *  0 only for contract acceptance, which a declared profile cannot reach.
 */
export function profileExitCode(r: ProfileReport): number {
  if (!r.technically_valid) return 2;
  if (r.has_confirmed_violation) return 1;
  if (r.contract_acceptance_passed) return 0;
  if (r.profile_acceptance_passed && r.supplement_acceptance_passed) return 3;
  return 2;
}

const cell = (s: string) => s.replace(/\|/g, '\\|');
export function profileSummary(r: ProfileReport): string {
  const f = (xs: { reason: string; step: number }[]) => xs.map(x => `${x.reason}@${x.step}`).join(', ');
  return `# Runtime Revocation & Containment Evaluation: declared profile\n\n> ${r.statement}\n\n` +
    `Version: ${r.version}. Mode: ${r.mode}. Observation source: ${r.observation_source}.\n\n` +
    `SUT: ${r.sut.repository} @ ${r.sut.commit} (tree ${r.sut.tree}, version ${r.sut.version}); lock SHA-256 ${r.sut.lock_sha256}; build SHA-256 ${r.sut.build_sha256}; baseline verified: ${r.sut.baseline_verified}.\n\n` +
    `Profile: ${r.profile.id} (SHA-256 ${r.profile.sha256}). Supplement: ${r.supplement_file.id} (SHA-256 ${r.supplement_file.sha256}). Corpus SHA-256: ${r.corpus_sha256}. Harness commit: ${r.harness_commit ?? 'unknown'} (worktree clean: ${r.harness_worktree_clean}).\n\n` +
    `Corpus coverage: ${r.corpus_coverage.in_profile}/${r.corpus_coverage.total} IN_PROFILE, ${r.counts.out_of_scope} OUT_OF_SCOPE. Profile pass rate: ${r.profile_pass_rate.pass}/${r.profile_pass_rate.in_profile}. ` +
    `PASS ${r.counts.PASS}; VIOLATION ${r.counts.VIOLATION}; UNASSESSABLE ${r.counts.UNASSESSABLE}; HARNESS_ERROR ${r.counts.HARNESS_ERROR}. Not assessed (finish/seal decisions): ${r.counts.not_assessed_requirements}.\n\n` +
    `Technically valid: ${r.technically_valid}. Has confirmed violation: ${r.has_confirmed_violation}. Contract acceptance passed: ${r.contract_acceptance_passed}. Profile acceptance passed: ${r.profile_acceptance_passed}. Supplement acceptance passed: ${r.supplement_acceptance_passed}.\n\n` +
    '## Corpus (all 27 cases)\n\n| Case | Family | Applicability | Tested property / out-of-scope reason | Verdict | Decision findings | Effect findings | Incomplete | Errors | Not assessed |\n|---|---|---|---|---|---|---|---|---|---|\n' +
    r.evidence.map(e => {
      const why = e.applicability === 'IN_PROFILE' ? `${(e as { tested_property: string }).tested_property}${'family_caveat' in e ? ` Caveat: ${(e as { family_caveat: string }).family_caveat}` : ''}` : (e as { out_of_scope: { capability_class: string; step: number; reason: string }[] }).out_of_scope.map(o => `${o.capability_class}@${o.step}: ${o.reason}`).join('<br>');
      return `| ${e.case_id} | ${e.family} | ${e.applicability} | ${cell(why)} | ${e.verdict ?? '—'} | ${f(e.decision_findings)} | ${f(e.effect_findings)} | ${cell(e.incomplete.join(', '))} | ${cell(e.errors.map(x => `${x.code} ${x.path}`).join(', '))} | ${e.not_assessed_requirements.join(', ')} |`;
    }).join('\n') +
    `\n\nState at cut is replayed from the corpus by the oracle (IN_PROFILE cases):\n\n` + r.evidence.filter(e => e.applicability === 'IN_PROFILE').map(e => `- ${e.case_id}: ${e.state_at_cut.map(renderCut).join('; ') || 'no cut'}`).join('\n') +
    `\n\nUncovered design fences: ${r.uncovered_design_fences.join('; ')}.\n\n` +
    `## Supplement (reported separately; not part of corpus coverage or the profile pass rate)\n\nAs declared: ${r.supplement.counts.matching}/${r.supplement.counts.total}. Technically valid: ${r.supplement.technically_valid}.\n\n| Case | Expectation | Declared verdict | Verdict | Findings | Incomplete | Errors | As declared |\n|---|---|---|---|---|---|---|---|\n` +
    r.supplement.cases.map(s => `| ${s.case_id} | ${s.expectation_source} | ${s.expected_result.verdict} | ${s.evidence.verdict} | ${f([...s.evidence.decision_findings, ...s.evidence.effect_findings])} | ${cell(s.evidence.incomplete.join(', '))} | ${cell(s.evidence.errors.map(x => x.code).join(', '))} | ${s.matches_declaration ? 'yes' : `no: ${cell(s.mismatches.join('; '))}`} |`).join('\n') +
    '\n\n' + r.limitations.map(l => `- ${l}`).join('\n') + '\n';
}
