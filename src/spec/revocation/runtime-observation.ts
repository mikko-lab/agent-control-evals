import { canonicalJson } from '../../util/canonical-json';
import { CallRecord, DecisionValue, DRIFT_POINTS, Effect, EffectKind, IdentityMapping, Probe, ProbePoint, ProbeState, Provenance, RuntimeTarget, Step, Target } from './model';

/**
 * Observation semantics of a pinned runtime adapter (revocation-0.4.0). Effects and decisions are derived from the raw
 * probe log and call records only: never from the oracle, the corpus design or the order of reported items. The
 * adapter reports what this module derives, and the evaluator re-derives it to check the report (section 4.6).
 */

/** Effect sources, per kind (section 3.6). */
export const EFFECT_PROVENANCE: Record<EffectKind, Provenance[]> = {
  approval_granted: ['sut_api'],
  permit_issued: ['sut_api'],
  revocation_ack: ['sut_api'],
  execution_started: ['harness_observation', 'sut_state'],
  tool_commit: ['sut_state'],
  output_delivery: ['sut_api'],
  cancellation_ack: ['sut_state'],
  execution_terminal: ['sut_state'],
};
export const DECISION_PROVENANCE: Provenance[] = ['sut_api'];

/** Contract target of a runtime revocation target, through the declared identity mapping (never guessed). */
export function contractTarget(t: RuntimeTarget, identity: IdentityMapping): Target {
  if (t.scope === 'capability') return { scope: 'authority', id: identity.capabilities[t.capability_id] ?? `unmapped:${t.capability_id}` };
  const pair = identity.sessions[t.session_id];
  return pair ? { scope: 'session', tenant: pair.tenant, session: pair.session } : { scope: 'session', tenant: 'unmapped', session: t.session_id };
}

/**
 * Authority of an execution label from the runtime's own binding at this probe (capability_id -> authority). Only
 * when the runtime has no record of the invocation does the request marker of the tool double's entry decide.
 */
function authorityOf(state: ProbeState, label: string, identity: IdentityMapping): string | null {
  const record = state.executions.find(x => x.label === label);
  if (record) return identity.capabilities[record.capability_id] ?? null;
  return state.entries.find(x => x.label === label)?.request_authority ?? null;
}

/** Facts present in one probe, keyed by a stable identity, with the effect each one denotes. */
export function facts(state: ProbeState, identity: IdentityMapping): Map<string, Omit<Effect, 'step'>> {
  const out = new Map<string, Omit<Effect, 'step'>>();
  const ex = (kind: EffectKind, label: string) => ({ kind, authority: authorityOf(state, label, identity), execution: label, target: null });
  for (const r of state.receipts) out.set(`ack@${r.step}`, { kind: 'revocation_ack', authority: null, execution: null, target: contractTarget(r.target, identity) });
  for (const x of state.entries) out.set(`start:${x.label}`, ex('execution_started', x.label));
  for (const m of state.managed) out.set(`commit:${m.key}`, ex('tool_commit', m.label));
  for (const d of state.deliveries) out.set(`deliver:${d.label}`, ex('output_delivery', d.label));
  for (const x of state.executions) {
    if (x.cancellation_acknowledged) out.set(`cack:${x.label}`, ex('cancellation_ack', x.label));
    if (x.state === 'terminal') out.set(`term:${x.label}`, ex('execution_terminal', x.label));
  }
  return out;
}

export interface DerivedEffect { key: string; effect: Effect & { seq: number }; point: ProbePoint }
export interface Derivation { effects: DerivedEffect[]; drift: { key: string; probe: number; point: ProbePoint }[]; regressions: string[] }

/**
 * Every fact's first presence. `seq` is the index of the first probe in which it was present, and its step is that
 * probe's step. A fact first present at a drift point appeared outside every step barrier, so it is not an effect
 * with an established occurrence step. A fact that disappears from a later probe is a regression of the log.
 */
export function derive(probes: Probe[], identity: IdentityMapping): Derivation {
  const seen = new Set<string>();
  const result: Derivation = { effects: [], drift: [], regressions: [] };
  let previous = new Set<string>();
  probes.forEach((p, k) => {
    const present = facts(p.state, identity);
    for (const key of previous) if (!present.has(key)) result.regressions.push(`${key} disappears at probe ${k}`);
    for (const [key, f] of present) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (DRIFT_POINTS.includes(p.point)) result.drift.push({ key, probe: k, point: p.point });
      else result.effects.push({ key, effect: { step: p.step, ...f, seq: k }, point: p.point });
    }
    previous = new Set(present.keys());
  });
  return result;
}

/** Structural defects of a probe log: indices are positions, steps never decrease. */
export function probeLogIssues(probes: Probe[]): string[] {
  const issues: string[] = [];
  probes.forEach((p, k) => {
    if (p.index !== k) issues.push(`probe at position ${k} has index ${p.index}`);
    if (k > 0 && p.step < probes[k - 1].step) issues.push(`probe ${k} step ${p.step} precedes step ${probes[k - 1].step}`);
  });
  return issues;
}

/**
 * The SUT's decision for one step, from its call record alone (section 3.2). finish and seal are harness control
 * steps and never have a SUT decision. Anything that is not a recognised SUT answer is UNKNOWN.
 */
export function decisionFromCall(step: Step, call: CallRecord | undefined): DecisionValue | undefined {
  if (step.op === 'finish' || step.op === 'seal') return undefined;
  if (!call) return undefined;
  switch (step.op) {
    case 'revoke': return call.outcome === 'returned' ? 'ALLOW' : call.outcome === 'threw' ? 'DENY' : 'UNKNOWN';
    case 'start':
    case 'approve': return call.outcome === 'tool_invoked' ? 'ALLOW' : call.outcome === 'rejected' && call.class === 'AuthorityRevokedError' ? 'DENY' : 'UNKNOWN';
    case 'commit': return call.outcome === 'returned' ? 'ALLOW' : call.outcome === 'threw' && call.class === 'CommitRejectedError' ? 'DENY' : 'UNKNOWN';
    case 'deliver': return call.outcome === 'fulfilled' && call.value === 'delivered' ? 'ALLOW' : call.outcome === 'fulfilled' && call.value === 'withheld_revoked' ? 'DENY' : 'UNKNOWN';
    case 'cancel_ack': return call.outcome === 'returned' && typeof call.value === 'boolean' ? (call.value ? 'ALLOW' : 'DENY') : 'UNKNOWN';
    default: return 'UNKNOWN';
  }
}

/** Canonical identity of a reported or derived runtime effect, including its step and sequence index. */
export const effectSlot = (f: Effect & { seq: number }) => canonicalJson({ step: f.step, seq: f.seq, kind: f.kind, authority: f.authority, execution: f.execution, target: f.target });
