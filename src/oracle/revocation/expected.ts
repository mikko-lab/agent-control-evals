import { Case, Effect, Expected } from '../../spec/revocation/model';
/** Specification-only oracle. No runtime observations or runtime implementation imports. */
export function expected(c: Case): Expected {
  const revoked = new Set<string>();
  const grant = new Map(c.authorities.map(a => [a.id, a.stage === 'pending' ? 'pending' : 'issued']));
  const executions = new Map<string, { authority: string; committed: boolean; delivered: boolean; terminal: boolean }>();
  const result: Expected = { decisions: [], effects: [] };
  c.steps.forEach((s, step) => {
    let allowed = true;
    let kind: Effect['kind'] | null = null;
    if (s.op === 'revoke') {
      const target = s.target;
      const matches = (id: string): boolean => {
        const a = c.authorities.find(a => a.id === id)!;
        if (target.scope === 'tenant') return a.tenant === target.tenant;
        if (target.scope === 'session') return a.tenant === target.tenant && a.session === target.session;
        return id === target.id || (a.parent !== null && matches(a.parent));
      };
      for (const a of c.authorities) if (matches(a.id)) revoked.add(a.id);
      kind = 'revocation_ack';
    } else if (s.op !== 'seal') {
      const e = 'execution' in s ? executions.get(s.execution) : undefined;
      const bound = e !== undefined && e.authority === s.authority;
      if (s.op === 'finish' || s.op === 'cancel_ack') {
        allowed = bound && !e!.terminal;
        if (allowed) { kind = s.op === 'finish' ? 'execution_terminal' : 'cancellation_ack'; if (s.op === 'finish') e!.terminal = true; }
      } else if (revoked.has(s.authority)) allowed = false;
      else if (s.op === 'approve') { allowed = grant.get(s.authority) === 'pending'; if (allowed) { grant.set(s.authority, 'approved'); kind = 'approval_granted'; } }
      else if (s.op === 'issue') { allowed = grant.get(s.authority) === 'approved'; if (allowed) { grant.set(s.authority, 'issued'); kind = 'permit_issued'; } }
      else if (s.op === 'start') {
        allowed = grant.get(s.authority) === 'issued' && !executions.has(s.execution);
        if (allowed) { grant.set(s.authority, 'consumed'); executions.set(s.execution, { authority: s.authority, committed: false, delivered: false, terminal: false }); kind = 'execution_started'; }
      } else if (s.op === 'commit') { allowed = bound && !e!.terminal && !e!.committed; if (allowed) { e!.committed = true; kind = 'tool_commit'; } }
      else if (s.op === 'deliver') { allowed = bound && !e!.terminal && e!.committed && !e!.delivered; if (allowed) { e!.delivered = true; kind = 'output_delivery'; } }
    }
    result.decisions.push({ step, decision: allowed ? 'ALLOW' : 'DENY' });
    if (kind) result.effects.push({ step, kind, authority: 'authority' in s ? s.authority : null, execution: 'execution' in s ? s.execution : null });
  });
  return result;
}
