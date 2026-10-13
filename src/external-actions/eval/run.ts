import { canonicalJsonLines } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { generateCases } from '../corpus/cases';
import { expected } from '../oracle/expected';
import { buildReport, Report } from '../report/report';
import { CaseDef, Evidence, Expected, Profile, PROFILE_FORMAT } from '../spec/model';
import { DEFAULT_RULES, evaluate, Rules } from './evaluate';

export const corpusBytes = (cases: CaseDef[] = generateCases()) => canonicalJsonLines(cases);
export const corpusSha256 = () => sha256Hex(corpusBytes());

/** Profile checks (fail closed): known format, corpus binding, known cases, no duplicates, and every case's control in scope (non-vacuity). */
export function profileIssues(profile: unknown, cases: CaseDef[]): string[] {
  const p = profile as Profile;
  const issues: string[] = [];
  if (typeof p !== 'object' || p === null) return ['profile is not an object'];
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'cases,corpus_sha256,format,profile_id,timing') issues.push(`profile has unexpected members: ${keys}`);
  if (p.format !== PROFILE_FORMAT) issues.push(`profile format must be ${PROFILE_FORMAT}`);
  if (typeof p.profile_id !== 'string' || !p.profile_id) issues.push('profile_id missing');
  if (p.corpus_sha256 !== sha256Hex(corpusBytes(cases))) issues.push('profile corpus_sha256 does not match the case corpus');
  const t = p.timing as unknown as Record<string, unknown>;
  const timingKeys = ['T_q_ms', 'T_r_ms', 'T_w_ms', 'deferred_persist_ms', 'xm13a_delay_ms', 'xm13b_delay_ms'];
  if (!t || Object.keys(t).sort().join(',') !== timingKeys.join(',') || timingKeys.some(k => !Number.isSafeInteger(t[k]) || (t[k] as number) < 0)) issues.push('profile timing must pin T_w_ms, T_q_ms, T_r_ms, xm13a_delay_ms, xm13b_delay_ms and deferred_persist_ms as non-negative integers');
  if (!Array.isArray(p.cases) || p.cases.length === 0) return [...issues, 'profile lists no cases'];
  if (new Set(p.cases).size !== p.cases.length) issues.push('profile lists a case twice');
  for (const id of p.cases) {
    const c = cases.find(x => x.id === id);
    if (!c) { issues.push(`profile names unknown case ${id}`); continue; }
    if (!p.cases.includes(c.control)) issues.push(`case ${id} needs its control ${c.control} in scope (non-vacuity)`);
  }
  return issues;
}

export interface RunResult { cases: CaseDef[]; truths: Expected[]; evidence: Evidence[]; report: Report }
/**
 * Evaluates one observation per profile case. Every oracle result is computed before any observation is looked at.
 * The observation list must name exactly the profile's cases (in any order).
 */
export function evaluateRun(profile: Profile, profileSha256: string, observations: unknown, rules: Rules = DEFAULT_RULES): RunResult {
  const all = generateCases();
  const issues = profileIssues(profile, all);
  if (issues.length) throw new Error(`profile rejected: ${issues.join('; ')}`);
  const cases = profile.cases.map(id => all.find(c => c.id === id)!);
  const truths = cases.map(expected);
  if (!Array.isArray(observations) || observations.length !== cases.length) throw new Error('expected exactly one observation per profile case');
  const ids = observations.map(o => typeof o === 'object' && o !== null ? (o as { case_id?: unknown }).case_id : undefined);
  if (new Set(ids).size !== cases.length || cases.some(c => !ids.includes(c.id))) throw new Error('observation case set does not match the profile');
  const evidence = cases.map((c, i) => evaluate(c, truths[i], observations[ids.indexOf(c.id)], profile, rules));
  const report = buildReport(cases, evidence, profile, profileSha256, sha256Hex(corpusBytes(all)), all.map(c => c.id));
  return { cases, truths, evidence, report };
}
