import { canonicalJson } from '../../util/canonical-json';
import { Authority, CallRecord, DecisionValue, DRIFT_POINTS, Effect, EffectKind, IdentityMapping, Probe, ProbePoint, ProbeState, Provenance, RuntimeTarget, Step, Target } from './model';

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
  if (t.scope === 'tenant') return { scope: 'tenant', tenant: identity.tenants?.[t.tenant_id] ?? `unmapped:${t.tenant_id}` };
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

/** The value the adapter writes for commit attempt n of an execution label; a commit is evidenced only by this value. */
export const commitValueJson = (label: string, n: number) => canonicalJson({ label, n });

/**
 * Facts present in one probe, keyed by a stable identity, with the effect each one denotes, and the facts whose
 * evidence in this probe is contradictory (section 3.6):
 *  - a terminal needs the execution state `terminal`, the snapshot's own terminal record for that same execution and
 *    exactly one entry for it in the executor's terminal log; any other combination is contradictory;
 *  - a commit needs its key in keys() and get(key) returning exactly the written value (the version check across
 *    probes is in derive()); a key without that value is contradictory.
 * A contradictory fact is not an effect: it is incomplete evidence, whatever the SUT's API answered.
 */
/** A fact whose evidence is contradictory: why, and the effect kind and execution label it concerns (null if none). */
export interface Contradiction { reason: string; kind: EffectKind; execution: string | null }

export function facts(state: ProbeState, identity: IdentityMapping): { present: Map<string, Omit<Effect, 'step'>>; inconsistent: Map<string, Contradiction> } {
  const out = new Map<string, Omit<Effect, 'step'>>();
  const inconsistent = new Map<string, Contradiction>();
  const known = new Set(state.executions.map(x => x.execution_id));
  const labelled = new Set([...state.executions.map(x => x.label), ...state.entries.map(x => x.label)]);
  const ex = (kind: EffectKind, label: string) => ({ kind, authority: authorityOf(state, label, identity), execution: label, target: null });
  for (const r of state.receipts) out.set(`ack@${r.step}`, { kind: 'revocation_ack', authority: null, execution: null, target: contractTarget(r.target, identity) });
  for (const x of state.entries) out.set(`start:${x.label}`, ex('execution_started', x.label));
  for (const m of state.managed) {
    if (m.value_json === commitValueJson(m.label, m.n)) out.set(`commit:${m.key}`, ex('tool_commit', m.label));
    else inconsistent.set(`commit:${m.key}`, { reason: m.value_json === null ? 'key listed but get(key) returned undefined' : `get(key) returned ${m.value_json}, not the written value`, kind: 'tool_commit', execution: labelled.has(m.label) ? m.label : null });
  }
  for (const d of state.deliveries) out.set(`deliver:${d.label}`, ex('output_delivery', d.label));
  for (const x of state.executions) {
    if (x.cancellation_acknowledged) out.set(`cack:${x.label}`, ex('cancellation_ack', x.label));
    const logged = state.terminals.filter(t => t.execution_id === x.execution_id).length;
    const record = x.terminal;
    if (x.state === 'terminal') {
      if (record && record.execution_id === x.execution_id && logged === 1) out.set(`term:${x.label}`, ex('execution_terminal', x.label));
      else inconsistent.set(`term:${x.label}`, { reason: `state terminal, but ${!record ? 'no terminal record in the snapshot' : record.execution_id !== x.execution_id ? `the snapshot's terminal record names ${record.execution_id}` : `${logged} entries in terminals()`}`, kind: 'execution_terminal', execution: x.label });
    } else if (record || logged > 0) inconsistent.set(`term:${x.label}`, { reason: `state ${x.state}, but ${record ? 'a terminal record' : `${logged} terminals() entries`} present`, kind: 'execution_terminal', execution: x.label });
  }
  for (const t of state.terminals) if (!known.has(t.execution_id)) inconsistent.set(`term:?${t.execution_id}`, { reason: `terminals() lists ${t.execution_id}, which no observed execution has`, kind: 'execution_terminal', execution: null });
  return { present: out, inconsistent };
}

export interface DerivedEffect { key: string; effect: Effect & { seq: number }; point: ProbePoint }
export interface Derivation {
  effects: DerivedEffect[];
  drift: { key: string; probe: number; point: ProbePoint }[];
  regressions: string[];
  /** Facts whose evidence is contradictory (first probe at which each was seen so). Never effects; incomplete evidence. */
  inconsistent: ({ key: string; probe: number } & Contradiction)[];
}

/**
 * Every fact's first presence. `seq` is the index of the first probe in which it was present, and its step is that
 * probe's step. A fact first present at a drift point appeared outside every step barrier, so it is not an effect
 * with an established occurrence step. A fact that disappears from a later probe is a regression of the log.
 */
export function derive(probes: Probe[], identity: IdentityMapping): Derivation {
  const seen = new Set<string>();
  const flagged = new Set<string>();
  const result: Derivation = { effects: [], drift: [], regressions: [], inconsistent: [] };
  const flag = (key: string, probe: number, x: Contradiction) => { if (!flagged.has(key)) { flagged.add(key); result.inconsistent.push({ key, probe, ...x }); } };
  let previous = new Set<string>();
  let previousVersion = 0;
  probes.forEach((p, k) => {
    const { present, inconsistent } = facts(p.state, identity);
    for (const [key, x] of inconsistent) flag(key, k, x);
    // A commit first present at this probe needs the managed-state version to have grown by at least one per new commit.
    const version = p.state.managed_version;
    if (version < previousVersion) result.regressions.push(`managed_version decreases at probe ${k}`);
    const newCommits = [...present.keys()].filter(key => key.startsWith('commit:') && !seen.has(key) && !flagged.has(key));
    if (newCommits.length > version - previousVersion) for (const key of newCommits) { flag(key, k, { reason: `managed_version ${previousVersion} -> ${version} does not account for ${newCommits.length} new commit(s)`, kind: 'tool_commit', execution: present.get(key)!.execution }); present.delete(key); }
    previousVersion = version;
    for (const key of previous) if (!present.has(key) && !flagged.has(key)) result.regressions.push(`${key} disappears at probe ${k}`);
    for (const [key, f] of present) {
      if (seen.has(key) || flagged.has(key)) continue;
      seen.add(key);
      if (DRIFT_POINTS.includes(p.point)) result.drift.push({ key, probe: k, point: p.point });
      else result.effects.push({ key, effect: { step: p.step, ...f, seq: k }, point: p.point });
    }
    previous = new Set([...present.keys()].filter(key => !flagged.has(key)));
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

/** The contract ancestors of an authority, parent first, from the case's own parent links (cycle-safe). */
export function contractAncestors(authorities: Authority[], id: string): string[] {
  const byId = new Map(authorities.map(a => [a.id, a]));
  const out: string[] = [];
  for (let p = byId.get(id)?.parent ?? null; p !== null && !out.includes(p); p = byId.get(p)?.parent ?? null) out.push(p);
  return out;
}

/**
 * Format 2 identity mapping against the case, before any runtime evidence is read (plan sections 7.5, 7.6):
 *  - one distinct runtime capability per authority, and nothing else;
 *  - exactly one runtime session per contract (tenant, session) pair, and no runtime session for two pairs;
 *  - exactly one runtime tenant per contract tenant, and no runtime tenant for two contract tenants;
 *  - for every authority, the chain the adapter supplied is exactly its contract ancestry, parent first.
 */
export function identityIssues(authorities: Authority[], identity: IdentityMapping): string[] {
  const issues: string[] = [];
  const capOf = new Map<string, string>();
  for (const [cap, a] of Object.entries(identity.capabilities)) {
    if (!authorities.some(x => x.id === a)) issues.push(`runtime capability ${cap} maps to unknown authority ${a}`);
    else if (capOf.has(a)) issues.push(`authority ${a} has more than one runtime capability`);
    else capOf.set(a, cap);
  }
  for (const a of authorities) if (!capOf.has(a.id)) issues.push(`authority ${a.id} has no runtime capability`);
  const pairs = new Map<string, string[]>();
  for (const [sid, pair] of Object.entries(identity.sessions)) pairs.set(`${pair.tenant}/${pair.session}`, [...(pairs.get(`${pair.tenant}/${pair.session}`) ?? []), sid]);
  for (const a of authorities) {
    const sids = pairs.get(`${a.tenant}/${a.session}`) ?? [];
    if (sids.length !== 1) issues.push(`pair ${a.tenant}/${a.session} of authority ${a.id} maps to ${sids.length} runtime sessions`);
  }
  for (const key of pairs.keys()) if (!authorities.some(a => `${a.tenant}/${a.session}` === key)) issues.push(`runtime session mapped to pair ${key}, which no authority has`);
  const tenants = identity.tenants ?? {};
  const runtimeTenantsOf = new Map<string, string[]>();
  for (const [rt, t] of Object.entries(tenants)) runtimeTenantsOf.set(t, [...(runtimeTenantsOf.get(t) ?? []), rt]);
  for (const t of new Set(authorities.map(a => a.tenant))) if ((runtimeTenantsOf.get(t) ?? []).length !== 1) issues.push(`contract tenant ${t} maps to ${(runtimeTenantsOf.get(t) ?? []).length} runtime tenants`);
  for (const t of runtimeTenantsOf.keys()) if (!authorities.some(a => a.tenant === t)) issues.push(`runtime tenant mapped to contract tenant ${t}, which no authority has`);
  const chains = identity.chains ?? {};
  for (const a of authorities) {
    const cap = capOf.get(a.id);
    if (!cap) continue;
    const want = contractAncestors(authorities, a.id).map(x => capOf.get(x) ?? `unmapped:${x}`);
    const got = chains[cap];
    if (!Array.isArray(got) || canonicalJson(got) !== canonicalJson(want)) issues.push(`authority ${a.id}: supplied chain ${JSON.stringify(got ?? null)} is not its contract ancestry ${JSON.stringify(want)}`);
  }
  for (const cap of Object.keys(chains)) if (!(cap in identity.capabilities)) issues.push(`chain declared for unknown runtime capability ${cap}`);
  return [...new Set(issues)];
}

/**
 * Format 2: a contract revocation is exactly one runtime revocation of the mapped target. Every receipt in the probe
 * log must belong to a revoke step, at most one per step, and acknowledge exactly that step's target. A tenant or an
 * ancestor revocation expressed as several session or capability revocations fails here.
 */
export function receiptIssues(steps: Step[], probes: Probe[], identity: IdentityMapping): string[] {
  const issues: string[] = [];
  const last = probes[probes.length - 1];
  if (!last) return issues;
  const byStep = new Map<number, RuntimeTarget[]>();
  for (const r of last.state.receipts) byStep.set(r.step, [...(byStep.get(r.step) ?? []), r.target]);
  for (const [step, targets] of byStep) {
    const s = steps[step];
    if (!s || s.op !== 'revoke') { issues.push(`runtime revocation receipt at step ${step}, which is not a revoke step`); continue; }
    if (targets.length !== 1) issues.push(`step ${step}: ${targets.length} runtime revocations for one contract revocation ${canonicalJson(s.target)}`);
    for (const t of targets) {
      const got = contractTarget(t, identity);
      if (canonicalJson(got) !== canonicalJson(s.target)) issues.push(`step ${step}: runtime revocation of ${canonicalJson(got)} acknowledges a contract revocation of ${canonicalJson(s.target)}`);
    }
  }
  return issues;
}

/**
 * Format 2: the runtime's own start-time binding of every observed execution must be the declared mapping of the
 * capability it runs under: the tenant of that authority and the chain supplied for that capability. A disagreement
 * means the identity mapping does not describe what the runtime enforced.
 */
export function bindingIssues(authorities: Authority[], probes: Probe[], identity: IdentityMapping): string[] {
  const issues = new Set<string>();
  for (const p of probes) for (const x of p.state.executions) {
    const a = authorities.find(y => y.id === identity.capabilities[x.capability_id]);
    if (!a) continue;
    const tenant = x.tenant_id == null ? null : identity.tenants?.[x.tenant_id] ?? `unmapped:${x.tenant_id}`;
    if (tenant !== a.tenant) issues.add(`execution ${x.label} is bound to tenant ${JSON.stringify(tenant)}, its authority ${a.id} to ${a.tenant}`);
    const want = identity.chains?.[x.capability_id] ?? [];
    if (canonicalJson(x.ancestor_capability_ids ?? []) !== canonicalJson(want)) issues.add(`execution ${x.label} is bound to the chain ${JSON.stringify(x.ancestor_capability_ids ?? [])}, the supplied chain is ${JSON.stringify(want)}`);
  }
  return [...issues];
}
