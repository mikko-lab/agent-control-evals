/**
 * P1b evaluation of a recorded run: the P1a evaluator over each observation (unchanged), the P1b run validity over
 * each run record, and a P1b report. Used in process at the end of a run and by the recorded CLI path
 * (`p1b-evaluate`), which must give the same bytes.
 */
import { sha256Hex } from '../../util/hash';
import { generateCases } from '../corpus/cases';
import { evaluate } from '../eval/evaluate';
import { corpusBytes, profileIssues } from '../eval/run';
import { expected } from '../oracle/expected';
import { buildReport, P1B_KIND, Report } from '../report/report';
import { Evidence, Profile } from '../spec/model';
import { planCase, RunConfig } from './config';
import { runValidity } from './validity';

export interface P1bRun { observations: unknown[]; records: unknown[] }
export interface P1bResult { evidence: Evidence[]; report: Report }

/** A case whose observation is missing is evaluated as a malformed observation: never a success. */
export const missingObservation = (caseId: string) => ({ case_id: caseId, missing: true });

export function evaluateP1bRun(profile: Profile, profileSha256: string, config: RunConfig, run: P1bRun): P1bResult {
  const all = generateCases();
  const issues = profileIssues(profile, all);
  if (issues.length) throw new Error(`profile rejected: ${issues.join('; ')}`);
  const cases = profile.cases.map(id => all.find(c => c.id === id)!);
  const truths = cases.map(expected);
  const byCase = (list: unknown[], id: string) => list.find(x => typeof x === 'object' && x !== null && (x as { case_id?: unknown }).case_id === id);
  if (run.observations.length !== cases.length || run.records.length !== cases.length) throw new Error('expected exactly one observation and one run record per profile case');
  const evidence = cases.map((c, i) => {
    const o = byCase(run.observations, c.id) ?? missingObservation(c.id);
    const e = evaluate(c, truths[i], o, profile);
    const v = runValidity(planCase(c, profile, config), config, o, byCase(run.records, c.id) ?? null);
    if (v.length) { e.errors.push(...v); e.verdict = 'HARNESS_ERROR'; }
    return e;
  });
  const report = buildReport(cases, evidence, profile, profileSha256, sha256Hex(corpusBytes(all)), all.map(c => c.id), P1B_KIND);
  return { evidence, report };
}
