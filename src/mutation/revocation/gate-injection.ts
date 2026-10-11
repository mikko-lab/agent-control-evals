/**
 * Gate-regression inputs of the eval mutant gate (docs/revocation/sut-pin-review-a9deab6.md): edits applied to one
 * mutant run's recorded observations before they are evaluated, so that the gate's own classification can be shown to
 * reject technical failures it must never count as kills. A run with injections is a regression input, never evidence.
 */
import type { Diagnostic, RuntimeObservation } from '../../spec/revocation/model';

export type Injection =
  /** Adds a top-level field to one case's observation (for example one the schema does not allow). */
  | { case_id: string; op: 'add_field'; field: string; value: unknown }
  /** Appends an adapter diagnostic to one case's observation (for example an extra barrier timeout). */
  | { case_id: string; op: 'add_diagnostic'; diagnostic: Diagnostic };
export interface InjectionInput { mutant: string; injections: Injection[] }

export class InjectionError extends Error {}

/** Applies the injections to a copy of the observations; fails closed on an unknown case, field clash or bad edit. */
export function applyInjections<T extends { corpus: RuntimeObservation[]; supplement: RuntimeObservation[] }>(observations: T, injections: Injection[]): T {
  const out = JSON.parse(JSON.stringify(observations)) as T;
  const all = [...out.corpus, ...out.supplement];
  for (const x of injections) {
    const o = all.find(y => y.case_id === x.case_id) as (RuntimeObservation & Record<string, unknown>) | undefined;
    if (!o) throw new InjectionError(`injection names unknown case ${x.case_id}`);
    if (x.op === 'add_field') {
      if (typeof x.field !== 'string' || !x.field || x.field in o) throw new InjectionError(`add_field ${String(x.field)} on ${x.case_id}: missing or existing field`);
      o[x.field] = x.value;
    } else if (x.op === 'add_diagnostic') {
      const d = x.diagnostic;
      if (!d || typeof d.code !== 'string' || typeof d.detail !== 'string' || !(d.step === null || Number.isInteger(d.step))) throw new InjectionError(`add_diagnostic on ${x.case_id}: malformed diagnostic`);
      o.diagnostics.push({ step: d.step, code: d.code, detail: d.detail });
    } else throw new InjectionError(`unknown injection op ${(x as { op?: unknown }).op}`);
  }
  return out;
}
