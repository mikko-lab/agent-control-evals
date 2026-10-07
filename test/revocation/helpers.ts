import { generateCorpus } from '../../src/corpus/revocation/cases';
import { expected } from '../../src/oracle/revocation/expected';
import { observe, Fault } from '../../src/adapter/revocation-reference/runtime';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { Case, Effect, Evidence, Observation } from '../../src/spec/revocation/model';
import { resolve } from 'node:path';
export const root = resolve(__dirname, '../../..');
export const cases = generateCorpus();
export const get = (id: string): Case => { const c = cases.find(c => c.id === id); if (!c) throw new Error(`no case ${id}`); return c; };
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** Baseline (or fault) observation of a corpus case, deep-copied for mutation in a test. */
export function fixture(id: string, fault?: Fault) { const c = get(id); return { c, truth: expected(c), o: clone(observe(c, fault)) as Observation }; }
export const run = (f: { c: Case; truth: ReturnType<typeof expected>; o: unknown }): Evidence => evaluate(f.c, f.truth, f.o);
export const effect = (step: number, kind: Effect['kind'], authority: string | null = 'a', execution: string | null = 'e1'): Effect => ({ step, kind, authority, execution, target: null });
export const findings = (xs: { reason: string; step: number }[]) => xs.map(x => `${x.reason}@${x.step}`).sort();
export const decisionAt = (o: Observation, step: number) => o.decisions.find(d => d.step === step)!;
