import { Authority, Case, Expected, ExpectedEffect, GrantState, StateAtCut, Target } from '../../spec/revocation/model';

/** True when the target covers the authority: the named tenant, tenant/session pair, or authority and its descendants. */
export function covers(authorities: Authority[], id: string, target: Target): boolean {
  const authority = authorities.find(x => x.id === id)!;
  if (target.scope === 'tenant') return authority.tenant === target.tenant;
  if (target.scope === 'session') return authority.tenant === target.tenant && authority.session === target.session;
  return id === target.id || (authority.parent !== null && covers(authorities, authority.parent, target));
}

/**
 * Specification-only oracle. No runtime observations or runtime implementation imports.
 * Besides the expected decisions and effect windows it records why each DENY is required (rationale)
 * and the replayed authority/execution state at every revocation cut.
 */
export function expected(c: Case): Expected {
  const seal = c.steps.findIndex(s => s.op === 'seal');
  const closing = seal < 0 ? c.steps.length - 1 : seal;
  const revoked = new Set<string>();
  const grant = new Map<string, GrantState>(c.authorities.map(x => [x.id, x.initial]));
  const executions = new Map<string, { authority: string; committed: boolean; delivered: boolean; closed: boolean; terminalExpected: boolean }>();
  const result: Expected = { decisions: [], effects: [], rationale: [], cuts: [] };
  // One terminal is expected per started execution. Its window opens at the first covering revocation while the
  // execution runs, or else at its first permitted finish request, and closes at the seal. SUT terminal reports never
  // feed back into policy expectations.
  const expectTerminal = (execution: string, step: number) => {
    const e = executions.get(execution)!;
    if (e.terminalExpected) return;
    e.terminalExpected = true;
    result.effects.push({ kind: 'execution_terminal', authority: e.authority, execution, target: null, earliest: step, latest: closing });
  };
  c.steps.forEach((s, step) => {
    const reasons: string[] = [];
    let effect: Omit<ExpectedEffect, 'earliest' | 'latest'> | null = null;
    if (s.op === 'revoke') {
      const before = new Set(revoked);
      for (const x of c.authorities) if (covers(c.authorities, x.id, s.target)) revoked.add(x.id);
      result.effects.push({ kind: 'revocation_ack', authority: null, execution: null, target: s.target, earliest: step, latest: step });
      result.cuts.push(snapshot(step, s.target, before));
      for (const [id, e] of executions) if (!e.closed && revoked.has(e.authority)) expectTerminal(id, step);
    } else if (s.op !== 'seal') {
      const e = 'execution' in s ? executions.get(s.execution) : undefined;
      const bound = e !== undefined && e.authority === s.authority;
      const fenced = s.op !== 'finish' && s.op !== 'cancel_ack';
      if (fenced && revoked.has(s.authority)) reasons.push('revoked');
      if (s.op === 'approve' && grant.get(s.authority) !== 'pending') reasons.push('not_pending');
      if (s.op === 'issue' && grant.get(s.authority) !== 'approved') reasons.push('not_approved');
      if (s.op === 'start') {
        const g = grant.get(s.authority);
        if (g !== 'issued') reasons.push(g === 'consumed' ? 'permit_consumed' : 'permit_not_issued');
        if (executions.has(s.execution)) reasons.push('execution_id_in_use');
      }
      if (s.op === 'commit' || s.op === 'deliver' || s.op === 'cancel_ack' || s.op === 'finish') {
        if (!bound) reasons.push('unbound_execution');
        else {
          // finish is an idempotent close/await request for a bound execution, also once it has already ended.
          if (e!.closed && s.op !== 'finish') reasons.push('finish_requested');
          if (s.op === 'commit' && e!.committed) reasons.push('already_committed');
          if (s.op === 'deliver' && !e!.committed) reasons.push('not_committed');
          if (s.op === 'deliver' && e!.delivered) reasons.push('already_delivered');
        }
      }
      if (reasons.length === 0) {
        const id = { authority: s.authority, execution: 'execution' in s ? s.execution : null, target: null };
        switch (s.op) {
          case 'approve': grant.set(s.authority, 'approved'); effect = { kind: 'approval_granted', ...id }; break;
          case 'issue': grant.set(s.authority, 'issued'); effect = { kind: 'permit_issued', ...id }; break;
          case 'start': grant.set(s.authority, 'consumed'); executions.set(s.execution, { authority: s.authority, committed: false, delivered: false, closed: false, terminalExpected: false }); effect = { kind: 'execution_started', ...id }; break;
          case 'commit': e!.committed = true; effect = { kind: 'tool_commit', ...id }; break;
          case 'deliver': e!.delivered = true; effect = { kind: 'output_delivery', ...id }; break;
          case 'cancel_ack': effect = { kind: 'cancellation_ack', ...id }; break;
          // A permitted finish request closes the execution and opens its terminal window unless a revocation already did.
          case 'finish': e!.closed = true; expectTerminal(s.execution, step); break;
        }
      }
    }
    result.decisions.push({ step, decision: reasons.length ? 'DENY' : 'ALLOW' });
    if (reasons.length) result.rationale.push({ step, reasons });
    if (effect) result.effects.push({ ...effect, earliest: step, latest: step });
  });
  return result;

  function snapshot(step: number, target: Target, before: Set<string>): StateAtCut {
    return {
      step, target,
      authorities: c.authorities.map(x => ({
        id: x.id,
        grant: grant.get(x.id)!,
        revoked: before.has(x.id) ? 'before_cut' : revoked.has(x.id) ? 'by_cut' : 'no',
        executions: [...executions].filter(([, e]) => e.authority === x.id).map(([id, e]) => ({ id, phase: e.closed ? 'finish_requested' : e.delivered ? 'delivered' : e.committed ? 'committed' : 'running' })),
      })),
    };
  }
}
