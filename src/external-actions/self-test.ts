/**
 * P1a self-test: golden corpus, pinned profile, committed fixtures, the full baseline profile, the verdict regressions
 * RV1-RV6 and the adapter mutants AX1-AX7, each compared with its pin. Everything here is synthetic harness validation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../util/canonical-json';
import { sha256Hex } from '../util/hash';
import { generateCases } from './corpus/cases';
import { evaluate, singleCaseExit } from './eval/evaluate';
import { corpusBytes, evaluateRun, RunResult } from './eval/run';
import { ALL_FIXTURES, BASELINE, buildFixture, fixtureById } from './fixtures/catalog';
import { ADAPTER_MUTANTS, MutantId, replacedRules } from './mutation/adapter-mutants';
import { expected } from './oracle/expected';
import { Evidence, Observation, Profile } from './spec/model';

export const PATHS = {
  corpus: 'corpus/external-actions/p1.jsonl',
  corpusSha: 'corpus/external-actions/p1.sha256',
  profile: 'profiles/external-actions/p1a-synthetic.profile.json',
  profileSha: 'profiles/external-actions/p1a-synthetic.profile.sha256',
  fixtures: 'test/fixtures/external-actions/observations',
  baselineObservations: 'test/fixtures/external-actions/p1a-baseline.observations.json',
  regressions: 'mutations/external-actions/verdict-regressions.json',
  regressionsSha: 'mutations/external-actions/verdict-regressions.sha256',
  mutants: 'mutations/external-actions/adapter-mutants.json',
  mutantsSha: 'mutations/external-actions/adapter-mutants.sha256',
};

/** The pinned form of one case result. */
export function pinOf(e: Evidence, exit: number) {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    verdict: e.verdict, exit,
    decision_findings: uniq(e.decision_findings.map(f => `${f.reason}@${f.attempt}`)),
    effect_findings: uniq(e.effect_findings.map(f => `${f.reason}@${f.recipient}${f.late ? ':late' : ''}`)),
    incomplete: uniq(e.incomplete.map(x => `${x.requirement}/${x.flag}`)),
    not_assessed: uniq(e.not_assessed.map(x => `${x.requirement}/${x.attempt}`)),
    errors: uniq(e.errors.map(x => x.code)),
    attribution: uniq(e.effects.filter(x => x.class === 'submission_received').map(x => `${x.ref}=${x.attribution.level}:${x.attribution.attempts.join('+')}`)),
  };
}
export type Pin = ReturnType<typeof pinOf>;

export const fixtureBytes = (o: Observation) => canonicalJson(o) + '\n';
export const subProfile = (p: Profile, cases: string[], suffix: string): Profile => ({ ...p, profile_id: `${p.profile_id}/${suffix}`, cases });
export const profileSha = (p: Profile) => sha256Hex(canonicalJson(p));

/** Verdict regressions (plan §7.2): fixed observations, each evaluated in a run with its case's control. */
export const REGRESSIONS: { id: string; input: string; with: string[]; meaning: string }[] = [
  { id: 'RV1', input: 'fill-no-submit~xm5', with: ['submit-allowed-P'], meaning: 'confirmed finding, complete evidence' },
  { id: 'RV2', input: 'fill-no-submit~xm5~q-chain-broken', with: ['submit-allowed-P'], meaning: 'confirmed finding and incompleteness, no harness error' },
  { id: 'RV3', input: 'fill-no-submit~xm5~canary-hit', with: ['submit-allowed-P'], meaning: 'confirmed finding and a harness error' },
  { id: 'RV4', input: 'submit-allowed-P~counter-mismatch', with: [], meaning: 'no finding, incompleteness' },
  { id: 'RV5', input: 'delayed-send~xm13b', with: ['submit-allowed-P'], meaning: 'no finding, complete records, final closure unconfirmed' },
  { id: 'RV6', input: 'submit-allowed-P', with: [], meaning: 'everything as expected' },
];
export const MUTANT_INPUTS: Record<MutantId, string[]> = {
  AX1: ['submit-allowed-P~recipient-rejects'], AX2: ['submit-allowed-P~recipient-rejects'], AX3: ['delayed-send~xm13a'],
  AX4: ['retry-delayed'], AX5: ['delayed-send~xm13b'], AX6: ['deferred-persist-allowed', 'deferred-persist-forbidden~xm12'],
  AX7: ['keepalive-multi-P', 'connection-no-request-P'],
};

export function loadProfile(root: string): { profile: Profile; sha256: string; bytes: Buffer } {
  const bytes = readFileSync(join(root, PATHS.profile));
  return { profile: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes), bytes };
}

export function runRegression(profile: Profile, rv: typeof REGRESSIONS[number]): { run: RunResult; caseId: string; pin: Pin; run_exit: number } {
  const cases = generateCases();
  const f = fixtureById(rv.input);
  const ids = [f.case_id, ...rv.with];
  const observations = [buildFixture(f, cases), ...rv.with.map(id => buildFixture(fixtureById(id), cases))];
  const p = subProfile(profile, ids, rv.id);
  const run = evaluateRun(p, profileSha(p), observations);
  const e = run.evidence[0];
  return { run, caseId: f.case_id, pin: pinOf(e, singleCaseExit(e)), run_exit: run.report.exit_code };
}

export function runMutant(profile: Profile, id: MutantId, input: string) {
  const cases = generateCases();
  const m = ADAPTER_MUTANTS.find(x => x.id === id)!;
  const f = fixtureById(input);
  const c = cases.find(x => x.id === f.case_id)!;
  const truth = expected(c);
  const o = buildFixture(f, cases);
  const correct = evaluate(c, truth, o, profile);
  const mutant = evaluate(c, truth, o, profile, m.rules);
  const pc = pinOf(correct, singleCaseExit(correct)), pm = pinOf(mutant, singleCaseExit(mutant));
  const sameExceptAttribution = canonicalJson({ ...pc, attribution: [] }) === canonicalJson({ ...pm, attribution: [] });
  const detection = pc.verdict !== pm.verdict ? 'verdict' : sameExceptAttribution && canonicalJson(pc.attribution) !== canonicalJson(pm.attribution) ? 'diagnosis' : canonicalJson(pc) === canonicalJson(pm) ? 'none' : 'findings_or_exit';
  return { correct: pc, mutant: pm, detection, replaced: replacedRules(m), technical: correct.verdict === 'HARNESS_ERROR' || mutant.verdict === 'HARNESS_ERROR' };
}

export interface SelfTestResult {
  goldens: { name: string; ok: boolean; detail: string }[];
  baseline: RunResult;
  regressions: { id: string; input: string; meaning: string; ok: boolean; pinned: unknown; observed: unknown }[];
  mutants: { id: string; input: string; status: string; ok: boolean; detection: string; pinned: unknown; observed: unknown }[];
  gate_passed: boolean;
}

export function selfTest(root: string): SelfTestResult {
  const goldens: SelfTestResult['goldens'] = [];
  const check = (name: string, ok: boolean, detail = '') => goldens.push({ name, ok, detail });
  const cases = generateCases();
  const corpus = corpusBytes(cases);
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  check('corpus bytes', read(PATHS.corpus) === corpus, PATHS.corpus);
  check('corpus sha256', read(PATHS.corpusSha).trim() === sha256Hex(corpus), PATHS.corpusSha);
  const { profile, sha256 } = loadProfile(root);
  check('profile sha256 pin', read(PATHS.profileSha).trim() === sha256, PATHS.profileSha);
  check('profile covers every P1 case', canonicalJson([...profile.cases].sort()) === canonicalJson(cases.map(c => c.id).sort()), PATHS.profile);
  for (const f of ALL_FIXTURES) {
    let bytes = '';
    try { bytes = read(`${PATHS.fixtures}/${f.id}.json`); } catch { /* reported below */ }
    check(`fixture ${f.id}`, bytes === fixtureBytes(buildFixture(f, cases)), `${PATHS.fixtures}/${f.id}.json`);
  }
  const baselineObservations = profile.cases.map(id => buildFixture(BASELINE.find(f => f.case_id === id)!, cases));
  check('baseline observations file', read(PATHS.baselineObservations) === canonicalJson(baselineObservations) + '\n', PATHS.baselineObservations);
  check('verdict regressions pin sha256', read(PATHS.regressionsSha).trim() === sha256Hex(read(PATHS.regressions)), PATHS.regressionsSha);
  check('adapter mutants pin sha256', read(PATHS.mutantsSha).trim() === sha256Hex(read(PATHS.mutants)), PATHS.mutantsSha);

  const baseline = evaluateRun(profile, sha256, baselineObservations);
  check('baseline full profile: every case PASS, exit 0', baseline.report.exit_code === 0 && baseline.report.counts.PASS === cases.length, `exit ${baseline.report.exit_code}`);

  const rvPins = JSON.parse(read(PATHS.regressions)) as { regressions: { id: string; input: string; case_id: string; run_exit: number; result: Pin }[] };
  const regressions = REGRESSIONS.map(rv => {
    const r = runRegression(profile, rv);
    const observed = { id: rv.id, input: rv.input, case_id: r.caseId, run_exit: r.run_exit, result: r.pin };
    const pinned = rvPins.regressions.find(x => x.id === rv.id) ?? null;
    return { id: rv.id, input: rv.input, meaning: rv.meaning, ok: pinned !== null && canonicalJson(pinned) === canonicalJson(observed), pinned, observed };
  });

  const axPins = JSON.parse(read(PATHS.mutants)) as { mutants: { id: MutantId; input: string; status: 'pinned' | 'regression'; detection: string; correct: Pin; mutant: Pin }[] };
  const mutants: SelfTestResult['mutants'] = [];
  for (const m of ADAPTER_MUTANTS) for (const input of MUTANT_INPUTS[m.id]) {
    const r = runMutant(profile, m.id, input);
    const pinned = axPins.mutants.find(x => x.id === m.id && x.input === input) ?? null;
    const observed = { correct: r.correct, mutant: r.mutant, detection: r.detection };
    const recorded = pinned !== null && canonicalJson({ correct: pinned.correct, mutant: pinned.mutant, detection: pinned.detection }) === canonicalJson(observed);
    const status = pinned?.status ?? 'missing';
    // A pinned mutant counts only when it reproduces its pin, replaces exactly one rule, is detected by verdict or
    // diagnosis, and neither evaluation is a technical failure. A regression entry is not counted as detection: it must
    // reproduce, and the mutant must keep earlier confirmed findings (a non-empty subset of the correct ones).
    const kept = r.mutant.effect_findings.length > 0 && r.mutant.effect_findings.every(f => r.correct.effect_findings.includes(f));
    const ok = recorded && r.replaced.length === 1 && !r.technical && ((status === 'regression' && kept) || (status === 'pinned' && (r.detection === 'verdict' || r.detection === 'diagnosis')));
    mutants.push({ id: m.id, input, status, ok, detection: r.detection, pinned, observed });
  }
  // Every mutant has at least one pinned witness whose detection is counted.
  for (const m of ADAPTER_MUTANTS) check(`${m.id} has a pinned witness`, mutants.some(x => x.id === m.id && x.status === 'pinned' && x.ok), PATHS.mutants);
  const gate_passed = goldens.every(g => g.ok) && regressions.every(r => r.ok) && mutants.every(m => m.ok);
  return { goldens, baseline, regressions, mutants, gate_passed };
}
