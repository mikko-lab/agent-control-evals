import { covers } from '../../oracle/revocation/expected';
import { Case, Expected, Step } from '../../spec/revocation/model';

const executionOf = (x: Step) => ('execution' in x ? x.execution : null);

/**
 * Applicability classifier for the declared runtime profile (docs/revocation/runtime-adapter-compatibility.md,
 * sections 2.2-2.3 and 3). It reads only a corpus case, the oracle's expectations for it and the profile's capability
 * rules; it never reads an observation or a report, so applicability is fixed before any runtime is invoked.
 */
export const CONTROL_OPS = ['finish', 'seal'] as const;
export type Applicability = 'IN_PROFILE' | 'OUT_OF_SCOPE';
export interface OutOfScopeRequirement { step: number; requirement: 'decision' | 'effect' | 'authority'; capability_class: string; reason: string }
export interface Classification { id: string; applicability: Applicability; out_of_scope: OutOfScopeRequirement[]; not_assessed_requirements: number[] }

/** Sole denial reasons the runtime cannot express, with their capability class. */
const SOLE_REASON_CLASS: Record<string, string> = {
  permit_consumed: 'single_use_permit',
  permit_not_issued: 'issue',
  execution_id_in_use: 'client_chosen_execution_id',
  already_committed: 'commit_once_only_sole_denial',
  not_committed: 'deliver_requires_commit_sole_denial',
};

export function classify(c: Case, truth: Expected): Classification {
  const out: OutOfScopeRequirement[] = [];
  const o = (step: number, requirement: OutOfScopeRequirement['requirement'], capability_class: string, reason: string) => out.push({ step, requirement, capability_class, reason });
  const decision = (step: number) => truth.decisions.find(d => d.step === step)!.decision;
  const reasons = (step: number) => truth.rationale.find(r => r.step === step)?.reasons ?? [];
  const notAssessed: number[] = [];

  for (const a of c.authorities) {
    if (a.initial !== 'pending') continue;
    const first = c.steps.findIndex(s => 'authority' in s && s.authority === a.id);
    o(Math.max(first, 0), 'authority', 'initial_pending_authority', `authority ${a.id} starts pending; the runtime has no pending grant before a request, and approval and start are one runtime operation`);
  }
  c.steps.forEach((s, step) => {
    if (s.op === 'finish' || s.op === 'seal') { notAssessed.push(step); return; }
    if (s.op === 'approve' || s.op === 'issue') {
      return s.op === 'approve'
        ? o(step, 'decision', 'approve', 'approval is not a separate runtime operation (resolveApproval also starts the execution)')
        : o(step, 'decision', 'issue', 'permits are minted inside the runtime start path and are neither invocable nor observable');
    }
    if (s.op === 'revoke') {
      if (s.target.scope === 'tenant') return o(step, 'decision', 'tenant_scope_revocation', 'the runtime has no tenant scope');
      if (s.target.scope === 'authority') {
        const id = s.target.id;
        const descendants = c.authorities.filter(x => x.id !== id && covers(c.authorities, x.id, { scope: 'authority', id }));
        if (descendants.length) return o(step, 'effect', 'descendant_coverage', `revocation of ${id} must also cover ${descendants.map(x => x.id).join(', ')}; a runtime capability revocation covers one capability`);
      }
      return;
    }
    if (s.op === 'start') {
      const rs = reasons(step);
      if (decision(step) === 'DENY' && !rs.includes('revoked')) for (const r of rs) if (SOLE_REASON_CLASS[r]) o(step, 'decision', SOLE_REASON_CLASS[r], `the denial rests on ${r} alone, which the runtime does not enforce`);
      return;
    }
    // commit, deliver, cancel_ack: need an execution the runtime started for this authority.
    const authority = s.authority, execution = executionOf(s);
    const startedBefore = c.steps.some((x, i) => i < step && x.op === 'start' && x.authority === authority && executionOf(x) === execution && decision(i) === 'ALLOW');
    if (!startedBefore) return o(step, 'decision', 'operation_on_execution_unknown_to_runtime', `${s.op} of ${authority}/${execution}, an execution the runtime never started; there is no execution context to call`);
    if (s.op === 'deliver' && c.steps.some((x, i) => i < step && x.op === 'finish' && x.authority === authority && executionOf(x) === execution && decision(i) === 'ALLOW')) {
      return o(step, 'decision', 'deliver_after_finish', 'the tool function has already settled at finish; the runtime has no later delivery operation');
    }
    if (s.op === 'cancel_ack' && !c.steps.some((x, i) => i < step && x.op === 'revoke' && covers(c.authorities, authority, x.target))) {
      return o(step, 'decision', 'cancel_ack_without_cancellation_request', 'the runtime acknowledges only a requested cancellation');
    }
    const rs = reasons(step);
    if (decision(step) === 'DENY' && rs.length === 1 && SOLE_REASON_CLASS[rs[0]] && (s.op === 'commit' || s.op === 'deliver')) o(step, 'decision', SOLE_REASON_CLASS[rs[0]], `the denial rests on ${rs[0]} alone, which the runtime does not enforce`);
  });
  return { id: c.id, applicability: out.length ? 'OUT_OF_SCOPE' : 'IN_PROFILE', out_of_scope: out, not_assessed_requirements: notAssessed };
}
