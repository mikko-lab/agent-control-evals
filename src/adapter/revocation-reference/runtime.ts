import { Case, EffectKind, Observation, Target } from '../../spec/revocation/model';
export const FAULTS = ['late_approval', 'stale_permit', 'session_bypass', 'commit_bypass', 'delivery_bypass', 'forgotten_descendants', 'deny_with_effect', 'erased_history'] as const;
export type Fault = typeof FAULTS[number];
/** Synthetic runtime. Effects are instrumented here, independently of policy decision records. */
export function observe(c: Case, fault?: Fault): Observation {
  const observation: Observation = { case_id: c.id, decisions: [], effects: [], complete: true };
  const grants = new Map(c.authorities.map(a => [a.id, { phase: a.stage === 'pending' ? 'pending' : 'issued', blocked: false, sessionBlocked: false }]));
  const jobs = new Map<string, { owner: string; committed: boolean; delivered: boolean; done: boolean }>();
  function affected(id: string, t: Target): boolean {
    const a = c.authorities.find(a => a.id === id)!;
    if (t.scope === 'tenant') return a.tenant === t.tenant;
    if (t.scope === 'session') return a.tenant === t.tenant && a.session === t.session;
    if (id === t.id) return true;
    return fault !== 'forgotten_descendants' && a.parent !== null && affected(a.parent, t);
  }
  c.steps.forEach((s, step) => {
    const emit = (kind: EffectKind) => observation.effects.push({ step, kind, authority: 'authority' in s ? s.authority : null, execution: 'execution' in s ? s.execution : null });
    if (s.op === 'seal') {
      // Instrumented scheduler drains every synthetic job before closing its trace.
      for (const [execution, job] of jobs) if (!job.done) { job.done = true; observation.effects.push({ step, kind: 'execution_terminal', authority: job.owner, execution }); }
      observation.decisions.push({ step, decision: 'ALLOW' }); return;
    }
    if (s.op === 'revoke') {
      for (const [id, state] of grants) if (affected(id, s.target)) { state.blocked = true; state.sessionBlocked = s.target.scope === 'session'; }
      observation.decisions.push({ step, decision: 'ALLOW' }); emit('revocation_ack');
      if (fault === 'erased_history') observation.effects = observation.effects.filter(e => e.kind !== 'tool_commit');
      return;
    }
    const state = grants.get(s.authority)!;
    const job = 'execution' in s ? jobs.get(s.execution) : undefined;
    const bound = !!job && job.owner === s.authority;
    let denied = state.blocked;
    if (s.op === 'finish' || s.op === 'cancel_ack') denied = false;
    if (fault === 'late_approval' && (s.op === 'approve' || s.op === 'issue')) denied = false;
    if (fault === 'stale_permit' && s.op === 'start') denied = false;
    if (fault === 'session_bypass' && state.sessionBlocked) denied = false;
    if (fault === 'commit_bypass' && s.op === 'commit') denied = false;
    if (fault === 'delivery_bypass' && s.op === 'deliver') denied = false;
    let effect: EffectKind | null = null;
    if (!denied) {
      switch (s.op) {
        case 'approve': denied = state.phase !== 'pending'; if (!denied) { state.phase = 'approved'; effect = 'approval_granted'; } break;
        case 'issue': denied = state.phase !== 'approved'; if (!denied) { state.phase = 'issued'; effect = 'permit_issued'; } break;
        case 'start': denied = state.phase !== 'issued' || jobs.has(s.execution); if (!denied) { state.phase = 'consumed'; jobs.set(s.execution, { owner: s.authority, committed: false, delivered: false, done: false }); effect = 'execution_started'; } break;
        case 'commit': denied = !bound || job!.done || job!.committed; if (!denied) { job!.committed = true; effect = 'tool_commit'; } break;
        case 'deliver': denied = !bound || job!.done || !job!.committed || job!.delivered; if (!denied) { job!.delivered = true; effect = 'output_delivery'; } break;
        case 'cancel_ack': denied = !bound || job!.done; if (!denied) effect = 'cancellation_ack'; break;
        case 'finish': denied = !bound || job!.done; if (!denied) { job!.done = true; effect = 'execution_terminal'; } break;
      }
    }
    observation.decisions.push({ step, decision: denied ? 'DENY' : 'ALLOW' });
    if (effect) emit(effect);
    // Fault remains a DENY decision: the independently recorded side effect exposes it.
    if (fault === 'deny_with_effect' && denied && s.op === 'commit' && bound && !job!.committed && !job!.done) { job!.committed = true; emit('tool_commit'); }
  });
  return observation;
}
