import { Case, Effect, EffectKind, GrantState, Observation, Target } from '../../spec/revocation/model';
export const FAULTS = [
  'late_approval', 'issue_bypass', 'stale_permit', 'session_start_bypass', 'session_in_flight_bypass', 'tenant_single_session',
  'commit_bypass', 'deny_with_effect', 'delivery_bypass', 'forgotten_descendants', 'erased_history',
  'decision_only_false_allow', 'decision_only_false_deny', 'write_behind_commit', 'execution_id_reuse',
] as const;
export type Fault = typeof FAULTS[number];
interface Job { owner: string; execution: string; committed: boolean; materialized: boolean; delivered: boolean; closed: boolean; cancelled: boolean }
/**
 * Synthetic runtime with its own state machine. Effects are instrumented here, independently of the policy decision
 * records. Faults act on scenario content (operations, scopes, sessions, ownership), never on case IDs or families.
 * Deterministic deferral: an execution that received a cancellation signal reports terminal one step after its finish
 * request (always no later than the seal). The seal never creates terminal evidence.
 */
export function observe(c: Case, fault?: Fault): Observation {
  const observation: Observation = { case_id: c.id, decisions: [], effects: [], complete: true };
  const grants = new Map(c.authorities.map(a => [a.id, { phase: a.initial as GrantState, blockedBy: new Set<Target['scope']>() }]));
  const jobs = new Map<string, Job>();
  const key = (authority: string, execution: string) => fault === 'execution_id_reuse' ? `${authority}/${execution}` : execution;
  const revokedTenants = new Set<string>();
  let deferredTerminals: Job[] = [];
  let buffered: { job: Job; armed: boolean }[] = [];
  function affected(id: string, t: Target): boolean {
    const a = c.authorities.find(a => a.id === id)!;
    if (t.scope === 'tenant') {
      if (a.tenant !== t.tenant) return false;
      if (fault !== 'tenant_single_session') return true;
      return a.session === c.authorities.filter(x => x.tenant === t.tenant).map(x => x.session).sort()[0];
    }
    if (t.scope === 'session') return a.tenant === t.tenant && a.session === t.session;
    if (id === t.id) return true;
    return fault !== 'forgotten_descendants' && a.parent !== null && affected(a.parent, t);
  }
  const push = (step: number, kind: EffectKind, authority: string | null, execution: string | null, target: Target | null = null) => { observation.effects.push({ step, kind, authority, execution, target } as Effect); };
  c.steps.forEach((s, step) => {
    for (const job of deferredTerminals) push(step, 'execution_terminal', job.owner, job.execution);
    deferredTerminals = [];
    // Write-behind fault: buffered commits materialize on the first step after the next cut, or at the seal.
    for (const b of buffered) if (b.armed || s.op === 'seal') { b.job.materialized = true; push(step, 'tool_commit', b.job.owner, b.job.execution); }
    buffered = buffered.filter(b => !b.job.materialized);
    if (s.op === 'seal') { observation.decisions.push({ step, decision: 'ALLOW' }); return; }
    if (s.op === 'revoke') {
      const covered = new Set(c.authorities.filter(a => affected(a.id, s.target)).map(a => a.id));
      for (const id of covered) { grants.get(id)!.blockedBy.add(s.target.scope); revokedTenants.add(c.authorities.find(a => a.id === id)!.tenant); }
      observation.decisions.push({ step, decision: 'ALLOW' });
      push(step, 'revocation_ack', null, null, s.target);
      if (fault === 'erased_history') {
        const owned = new Set([...jobs.values()].filter(j => covered.has(j.owner)).map(j => j.execution));
        observation.effects = observation.effects.filter(e => !((e.kind === 'tool_commit' || e.kind === 'output_delivery') && e.execution !== null && owned.has(e.execution)));
      }
      for (const b of buffered) b.armed = true;
      return;
    }
    const state = grants.get(s.authority)!;
    const job = 'execution' in s ? jobs.get(key(s.authority, s.execution)) : undefined;
    const bound = !!job && job.owner === s.authority;
    const fenced = s.op !== 'finish' && s.op !== 'cancel_ack';
    const ignored = (scope: Target['scope']) =>
      (fault === 'late_approval' && s.op === 'approve') || (fault === 'issue_bypass' && s.op === 'issue') ||
      (fault === 'stale_permit' && s.op === 'start') || (fault === 'commit_bypass' && s.op === 'commit') ||
      (fault === 'delivery_bypass' && s.op === 'deliver') ||
      (fault === 'session_start_bypass' && s.op === 'start' && scope === 'session') ||
      (fault === 'session_in_flight_bypass' && (s.op === 'commit' || s.op === 'deliver') && scope === 'session');
    const blocked = fenced && [...state.blockedBy].some(scope => !ignored(scope));
    let refused = false;
    switch (s.op) {
      case 'approve': refused = state.phase !== 'pending'; break;
      case 'issue': refused = state.phase !== 'approved'; break;
      case 'start': refused = state.phase !== 'issued' || jobs.has(key(s.authority, s.execution)); break;
      case 'commit': refused = !bound || job!.closed || job!.committed; break;
      case 'deliver': refused = !bound || job!.closed || !job!.committed || job!.delivered || (fault === 'write_behind_commit' && !job!.materialized); break;
      case 'cancel_ack': case 'finish': refused = !bound || job!.closed; break;
    }
    const denied = blocked || refused;
    if (!denied) {
      switch (s.op) {
        case 'approve': state.phase = 'approved'; push(step, 'approval_granted', s.authority, null); break;
        case 'issue': state.phase = 'issued'; push(step, 'permit_issued', s.authority, null); break;
        case 'start': state.phase = 'consumed'; jobs.set(key(s.authority, s.execution), { owner: s.authority, execution: s.execution, committed: false, materialized: false, delivered: false, closed: false, cancelled: false }); push(step, 'execution_started', s.authority, s.execution); break;
        case 'commit':
          job!.committed = true;
          if (fault === 'write_behind_commit') buffered.push({ job: job!, armed: false });
          else { job!.materialized = true; push(step, 'tool_commit', s.authority, s.execution); }
          break;
        case 'deliver': job!.delivered = true; push(step, 'output_delivery', s.authority, s.execution); break;
        case 'cancel_ack': job!.cancelled = true; push(step, 'cancellation_ack', s.authority, s.execution); break;
        case 'finish': job!.closed = true; if (job!.cancelled) deferredTerminals.push(job!); else push(step, 'execution_terminal', s.authority, s.execution); break;
      }
    }
    // Fault keeps a DENY decision: only the independently recorded side effect exposes it.
    if (fault === 'deny_with_effect' && denied && s.op === 'commit' && bound && !job!.committed && !job!.closed) { job!.committed = true; job!.materialized = true; push(step, 'tool_commit', s.authority, s.execution); }
    let logged: 'ALLOW' | 'DENY' = denied ? 'DENY' : 'ALLOW';
    // Decision-only faults corrupt the decision record while enforcement stays correct.
    if (fault === 'decision_only_false_allow' && blocked && !refused) logged = 'ALLOW';
    if (fault === 'decision_only_false_deny' && !denied && fenced && revokedTenants.has(c.authorities.find(a => a.id === s.authority)!.tenant)) logged = 'DENY';
    observation.decisions.push({ step, decision: logged });
  });
  return observation;
}
