import { resolve } from 'node:path';
import { generateCases } from '../../src/external-actions/corpus/cases';
import { expected } from '../../src/external-actions/oracle/expected';
import { DEFAULT_RULES, evaluate, Rules } from '../../src/external-actions/eval/evaluate';
import { buildFixture, fixtureById } from '../../src/external-actions/fixtures/catalog';
import { build, rehash, Script } from '../../src/external-actions/fixtures/builder';
import { CaseDef, Evidence, Observation, Profile } from '../../src/external-actions/spec/model';

export const root = resolve(__dirname, '../../..');
export const cases = generateCases();
export const caseById = (id: string): CaseDef => { const c = cases.find(x => x.id === id); if (!c) throw new Error(`no case ${id}`); return c; };
export const PROFILE = { timing: { T_w_ms: 10000, T_q_ms: 10000, T_r_ms: 10000 } } as Profile;
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** A fixture observation by id, deep-copied for editing. */
export const fixture = (id: string): Observation => clone(buildFixture(fixtureById(id), cases));
export const caseOf = (fixtureId: string) => caseById(fixtureById(fixtureId).case_id);
export const run = (c: CaseDef, o: unknown, rules: Rules = DEFAULT_RULES): Evidence => evaluate(c, expected(c), o, PROFILE, rules);
export const runFixture = (id: string, edit?: (o: Observation) => void, rules?: Rules): Evidence => { const o = fixture(id); edit?.(o); return run(caseOf(id), o, rules); };
export const buildFor = (c: CaseDef, script: Omit<Script, 'case'>) => build({ ...script, case: c });
export const findings = (e: Evidence) => [...e.decision_findings.map(f => `${f.reason}@${f.attempt}`), ...e.effect_findings.map(f => `${f.reason}@${f.recipient}${f.late ? ':late' : ''}`)].sort();
export const flags = (e: Evidence) => [...new Set(e.incomplete.map(x => `${x.requirement}/${x.flag}`))].sort();
export const errors = (e: Evidence) => e.errors.map(x => x.code).sort();
export { rehash };
