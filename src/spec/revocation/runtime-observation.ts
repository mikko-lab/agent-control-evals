import { canonicalJson } from '../../util/canonical-json';
import { Authority, CallRecord, DecisionValue, DRIFT_POINTS, Effect, EffectKind, IdentityMapping, LineageObservation, Probe, ProbePoint, ProbeState, Provenance, RuntimeTarget, Step, Target } from './model';

/**
 * Observation semantics of a pinned runtime adapter (revocation-0.4.0). Effects and decisions are derived from the raw
 * probe log and call records only: never from the oracle, the corpus design or the order of reported items. The
 * adapter reports what this module derives, and the evaluator re-derives it to check the report (section 4.6).
 */

/**
 * Effect sources, per kind (section 3.6). approval_granted and permit_issued exist only in format 3, where they are
 * lineage-state transitions of the runtime's own snapshots (approval-permit lifecycle plan section 7.1), never a
 * receipt, a return value or an audit record.
 */
export const EFFECT_PROVENANCE: Record<EffectKind, Provenance[]> = {
  approval_granted: ['sut_state'],
  permit_issued: ['sut_state'],
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
/**
 * authority: the contract authority the fact belongs to, when it is known (format 3 lifecycle facts); absent or null
 * means the fact names no authority and concerns that kind and execution for every authority.
 */
export interface Contradiction { reason: string; kind: EffectKind; execution: string | null; authority?: string | null }

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
  // Format 3: lifecycle effects are transitions after the setup baseline (lifecycleTransitions), never first presence.
  const lifecycle = lifecycleTransitions(probes);
  result.regressions.push(...lifecycle.regressions);
  // A lifecycle contradiction concerns its own lineage's authority only (and, for a consumption, the execution it names
  // when an observed execution has that id); it never concerns another authority's expectations.
  for (const x of lifecycle.inconsistent) {
    const label = x.execution_id === null ? null : probes[x.probe].state.executions.find(e => e.execution_id === x.execution_id)?.label ?? null;
    flag(x.key, x.probe, { reason: x.reason, kind: x.kind, execution: label, authority: identity.lineages?.[x.lineage_id] ?? `unmapped:${x.lineage_id}` });
  }
  const transitionsAt = new Map<number, LifecycleTransition[]>();
  for (const t of lifecycle.transitions) if (t.kind !== 'permit_consumed') transitionsAt.set(t.probe, [...(transitionsAt.get(t.probe) ?? []), t]);
  probes.forEach((p, k) => {
    for (const t of transitionsAt.get(k) ?? []) {
      if (flagged.has(t.key)) continue;
      if (DRIFT_POINTS.includes(p.point)) result.drift.push({ key: t.key, probe: k, point: p.point });
      else result.effects.push({ key: t.key, effect: { step: p.step, kind: t.kind as EffectKind, authority: identity.lineages?.[t.lineage_id] ?? `unmapped:${t.lineage_id}`, execution: null, target: null, seq: k }, point: p.point });
    }
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

/** A lifecycle transition of one lineage, first shown at probe `probe` (format 3). */
export interface LifecycleTransition { key: string; kind: 'approval_granted' | 'permit_issued' | 'permit_consumed'; lineage_id: string; probe: number; seq: number | null }

const APPROVAL_RANK: Record<string, number> = { pending: 0, approved: 1, rejected: 1, expired: 1 };
const PERMIT_RANK: Record<string, number> = { none: 0, issued: 1, consumed: 2, expired: 2 };

/**
 * Format 3 (approval-permit lifecycle plan section 7.1): the lifecycle transitions of the probe log after the setup
 * baseline. The reference is the setup_baseline probe (the first probe; without it, the first probe with lineage
 * snapshots, and lineageIssues reports the missing baseline). A transition is a change between consecutive probes:
 *  - approval_granted: approval_state pending -> approved;
 *  - permit_issued: permit_state none -> issued (or on to consumed within the same interval);
 *  - permit_consumed: permit_state issued -> consumed, or none -> consumed (no contract effect; attributed by lineageIssues).
 * A transition's own sequence value must lie after the baseline and inside the interval in which it is first shown
 * (after the previous probe's authority_seq, at most this probe's). Otherwise its evidence is contradictory: no effect
 * is derived from it (for example a setup-time approval surfacing after the baseline). A state that is already present
 * at the baseline is never a transition. A lineage that disappears, an authority sequence that decreases and a state
 * that moves backwards are regressions of the log.
 */
export interface LifecycleContradiction { key: string; probe: number; kind: EffectKind; reason: string; lineage_id: string; execution_id: string | null }
export function lifecycleTransitions(probes: Probe[]): { transitions: LifecycleTransition[]; inconsistent: LifecycleContradiction[]; regressions: string[] } {
  const out = { transitions: [] as LifecycleTransition[], inconsistent: [] as LifecycleContradiction[], regressions: [] as string[] };
  let prev: Map<string, LineageObservation> | null = null;
  let prevSeq = 0;
  let baselineSeq: number | null = null;
  probes.forEach((p, k) => {
    if (p.state.lineages === undefined) return;
    const cur = new Map(p.state.lineages.map(l => [l.lineage_id, l]));
    const seqNow = p.state.authority_seq ?? 0;
    if (prev === null) {
      if (p.point === 'setup_baseline') baselineSeq = seqNow;
      prev = cur; prevSeq = seqNow;
      return;
    }
    if (seqNow < prevSeq) out.regressions.push(`authority_seq decreases at probe ${k} (${prevSeq} -> ${seqNow})`);
    for (const id of prev.keys()) if (!cur.has(id)) out.regressions.push(`lineage ${id} disappears at probe ${k}`);
    const within = (seq: number | null) => seq !== null && seq > (baselineSeq ?? -1) && seq > prevSeq && seq <= seqNow;
    const why = (name: string, seq: number | null) => `${name} ${seq === null ? 'missing' : seq} is not after the setup baseline (baseline_seq ${baselineSeq ?? 'none'}) and inside the interval ${prevSeq}..${seqNow} in which it is first shown`;
    for (const [id, l] of cur) {
      const b = prev.get(id);
      if (!b) continue;
      if ((APPROVAL_RANK[l.approval_state] ?? 0) < (APPROVAL_RANK[b.approval_state] ?? 0) || (APPROVAL_RANK[b.approval_state] === 1 && l.approval_state !== b.approval_state)) out.regressions.push(`lineage ${id} approval_state ${b.approval_state} -> ${l.approval_state} at probe ${k}`);
      if ((PERMIT_RANK[l.permit_state] ?? 0) < (PERMIT_RANK[b.permit_state] ?? 0) || (PERMIT_RANK[b.permit_state] === 2 && l.permit_state !== b.permit_state)) out.regressions.push(`lineage ${id} permit_state ${b.permit_state} -> ${l.permit_state} at probe ${k}`);
      if (b.approval_state === 'pending' && l.approval_state === 'approved') {
        const key = `approve:${id}`;
        if (within(l.approved_seq)) out.transitions.push({ key, kind: 'approval_granted', lineage_id: id, probe: k, seq: l.approved_seq });
        else out.inconsistent.push({ key, probe: k, kind: 'approval_granted', reason: why('approved_seq', l.approved_seq), lineage_id: id, execution_id: null });
      }
      if (b.permit_state === 'none' && (l.permit_state === 'issued' || l.permit_state === 'consumed')) {
        const key = `permit:${id}`;
        if (within(l.issued_seq)) out.transitions.push({ key, kind: 'permit_issued', lineage_id: id, probe: k, seq: l.issued_seq });
        else out.inconsistent.push({ key, probe: k, kind: 'permit_issued', reason: why('issued_seq', l.issued_seq), lineage_id: id, execution_id: null });
      }
      if (b.permit_state !== 'consumed' && l.permit_state === 'consumed') {
        const key = `consume:${id}`;
        if (within(l.consumed_seq)) out.transitions.push({ key, kind: 'permit_consumed', lineage_id: id, probe: k, seq: l.consumed_seq });
        else out.inconsistent.push({ key, probe: k, kind: 'execution_started', reason: why('consumed_seq', l.consumed_seq), lineage_id: id, execution_id: l.execution_id });
      }
    }
    prev = cur; prevSeq = seqNow;
  });
  return out;
}

/** The runtime call API of a step's operation in format 3 (permit mode). */
export const PERMIT_API: Partial<Record<Step['op'], CallRecord['api']>> = { revoke: 'revoke', approve: 'approve', issue: 'issuePermit', start: 'start', commit: 'commit', deliver: 'deliver', cancel_ack: 'acknowledgeCancellation' };
const TRANSITION_OP: Record<LifecycleTransition['kind'], Step['op']> = { approval_granted: 'approve', permit_issued: 'issue', permit_consumed: 'start' };

/**
 * Format 3 identity and lifecycle checks (approval-permit lifecycle plan sections 7.1, 7.2, 8.3):
 *  - identity: exactly one runtime lineage per authority, mapped to a known authority (AM17); the first probe, and only
 *    it, is the setup baseline; the baseline shows exactly the mapped lineages, each in its authority's `initial`
 *    state (pending: approval pending and no permit; issued: approved and an issued, unconsumed permit, both before
 *    the baseline) and bound to its authority's capability, session pair, tenant and supplied chain (AM15); no lineage
 *    appears after the baseline and no lineage's bindings change;
 *  - transitions: every post-baseline transition shown at a step barrier occurred at a step whose own runtime call
 *    can make it: an approval at an approve step of the lineage's authority with an approve call, an issue at an issue
 *    step with an issuePermit call, a consumption at a start step with a start call, whose start request is the
 *    consumption's start_request_id and whose execution, when the runtime started one, is the consumption's
 *    execution_id (AM18).
 */
/** An observed start without its own permit consumption: incomplete state evidence of that execution (format 3). */
export interface MissingConsumption { probe: number; execution: string; authority: string | null; reason: string }

export function lineageIssues(authorities: Authority[], steps: Step[], probes: Probe[], calls: CallRecord[], identity: IdentityMapping): { identity: string[]; transitions: string[]; missing: MissingConsumption[] } {
  const idIssues: string[] = [];
  const trIssues: string[] = [];
  const missing: MissingConsumption[] = [];
  const lineages = identity.lineages ?? {};
  const byAuthority = new Map<string, string[]>();
  for (const [lid, a] of Object.entries(lineages)) {
    if (!authorities.some(x => x.id === a)) idIssues.push(`runtime lineage ${lid} maps to unknown authority ${a}`);
    byAuthority.set(a, [...(byAuthority.get(a) ?? []), lid]);
  }
  for (const a of authorities) if ((byAuthority.get(a.id) ?? []).length !== 1) idIssues.push(`authority ${a.id} maps to ${(byAuthority.get(a.id) ?? []).length} runtime lineages`);
  const baselines = probes.map((p, k) => ({ p, k })).filter(x => x.p.point === 'setup_baseline');
  if (baselines.length !== 1 || baselines[0].k !== 0) idIssues.push(`the probe log has ${baselines.length} setup_baseline probe(s)${baselines.length ? ` at ${baselines.map(x => x.k).join(', ')}` : ''}; exactly one, the first, is required`);
  const capOf = new Map(Object.entries(identity.capabilities).map(([cap, a]) => [a, cap]));
  const base = probes[0]?.point === 'setup_baseline' ? probes[0].state : undefined;
  if (base) {
    const seen = new Set((base.lineages ?? []).map(l => l.lineage_id));
    for (const lid of Object.keys(lineages)) if (!seen.has(lid)) idIssues.push(`the setup baseline does not show lineage ${lid}`);
    for (const l of base.lineages ?? []) {
      const a = authorities.find(x => x.id === lineages[l.lineage_id]);
      if (!a) { idIssues.push(`the setup baseline shows lineage ${l.lineage_id}, which the identity mapping does not declare`); continue; }
      const seqOk = (x: number | null) => x !== null && x <= (base.authority_seq ?? -1);
      const ok = a.initial === 'pending'
        ? l.state === 'pending' && l.approval_state === 'pending' && l.permit_state === 'none' && l.approved_seq === null && l.issued_seq === null
        : l.state === 'issued' && l.approval_state === 'approved' && l.permit_state === 'issued' && l.consumed_seq === null && seqOk(l.approved_seq) && seqOk(l.issued_seq);
      if (!ok) idIssues.push(`the setup baseline shows lineage ${l.lineage_id} of ${a.id} as ${l.state} (approval ${l.approval_state}, permit ${l.permit_state}), not its initial state ${a.initial}`);
      const pair = identity.sessions[l.session_id];
      if (identity.capabilities[l.capability_id] !== a.id || capOf.get(a.id) !== l.capability_id) idIssues.push(`lineage ${l.lineage_id} is bound to capability ${l.capability_id}, not that of ${a.id}`);
      if (!pair || pair.tenant !== a.tenant || pair.session !== a.session) idIssues.push(`lineage ${l.lineage_id} is bound to session ${l.session_id}, not the pair ${a.tenant}/${a.session} of ${a.id}`);
      if ((l.tenant_id === null ? null : identity.tenants?.[l.tenant_id] ?? `unmapped:${l.tenant_id}`) !== a.tenant) idIssues.push(`lineage ${l.lineage_id} is bound to tenant ${JSON.stringify(l.tenant_id)}, not that of ${a.id}`);
      if (canonicalJson(l.ancestor_capability_ids) !== canonicalJson(identity.chains?.[l.capability_id] ?? [])) idIssues.push(`lineage ${l.lineage_id} is bound to the chain ${JSON.stringify(l.ancestor_capability_ids)}, the supplied chain is ${JSON.stringify(identity.chains?.[l.capability_id] ?? [])}`);
    }
  }
  const bindingOf = (l: LineageObservation) => canonicalJson([l.capability_id, l.ancestor_capability_ids, l.session_id, l.tenant_id, l.agent_id, l.tool, l.arguments_digest, l.request_id, l.request_digest, l.created_seq]);
  const first = new Map<string, string>();
  probes.forEach((p, k) => {
    for (const l of p.state.lineages ?? []) {
      if (!(l.lineage_id in lineages)) idIssues.push(`lineage ${l.lineage_id} appears at probe ${k}, after the setup, without an authority`);
      const b = bindingOf(l);
      if (!first.has(l.lineage_id)) first.set(l.lineage_id, b);
      else if (first.get(l.lineage_id) !== b) idIssues.push(`the bindings of lineage ${l.lineage_id} change at probe ${k}`);
    }
  });
  const last = probes[probes.length - 1]?.state;
  const transitions = lifecycleTransitions(probes).transitions;
  const knownExecutions = new Set(probes.flatMap(p => [...p.state.executions.map(x => x.execution_id), ...p.state.entries.map(x => x.execution_id)]));
  for (const t of transitions) {
    const p = probes[t.probe];
    if (DRIFT_POINTS.includes(p.point)) continue;
    const s = steps[p.step];
    const authority = lineages[t.lineage_id];
    const call = calls.find(x => x.step === p.step);
    const want = TRANSITION_OP[t.kind];
    if (!s || s.op !== want || !('authority' in s) || s.authority !== authority) { trIssues.push(`${t.kind} of lineage ${t.lineage_id} (${authority ?? 'unmapped'}) first shown at step ${p.step} (${s?.op ?? 'none'}), not at a ${want} step of ${authority ?? 'its authority'}`); continue; }
    if (!call || call.api !== PERMIT_API[want]) { trIssues.push(`${t.kind} of lineage ${t.lineage_id} at step ${p.step}: the step's own call is ${call?.api ?? 'missing'}, not ${PERMIT_API[want]}`); continue; }
    if (t.kind === 'permit_consumed') {
      const l = p.state.lineages!.find(x => x.lineage_id === t.lineage_id)!;
      const label = (s as { execution: string }).execution;
      if (l.start_request_id !== (call.request_id ?? null)) trIssues.push(`permit of lineage ${t.lineage_id} consumed by start request ${l.start_request_id}, step ${p.step} submitted ${call.request_id ?? 'none'}`);
      const started = last?.executions.find(x => x.execution_id === l.execution_id);
      if (l.execution_id !== null && !knownExecutions.has(l.execution_id)) trIssues.push(`permit of lineage ${t.lineage_id} consumed for execution ${l.execution_id}, which no observed execution has (step ${p.step} starts ${label})`);
      else if (l.execution_id !== null && started && started.label !== label) trIssues.push(`permit of lineage ${t.lineage_id} consumed for execution ${started.label}, step ${p.step} starts ${label}`);
    }
  }
  // The other direction: every observed start needs the permit consumption of its own authority's lineage, first shown
  // at the start's own step, naming exactly that execution and that step's start request. Missing or other consumption
  // evidence leaves the start's state evidence incomplete (never PASS); its findings stay.
  for (const entry of last?.entries ?? []) {
    const record = last!.executions.find(x => x.execution_id === entry.execution_id);
    const startSteps = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.op === 'start' && s.execution === entry.label);
    const own = startSteps.map(({ i }) => ({ i, call: calls.find(c => c.step === i && c.api === 'start') })).find(({ call }) => call && (!record || call.request_id === record.request_id));
    const authority = record ? identity.capabilities[record.capability_id] ?? null : entry.request_authority;
    const lineageId = Object.entries(lineages).find(([, a]) => a === authority)?.[0];
    const at = probes.findIndex(p => p.state.entries.some(x => x.label === entry.label));
    const l = lineageId ? last!.lineages?.find(x => x.lineage_id === lineageId) : undefined;
    const consumption = lineageId ? transitions.find(t => t.kind === 'permit_consumed' && t.lineage_id === lineageId) : undefined;
    const why = !own ? `no start call of step starting ${entry.label} names its request` : !l ? `its authority ${authority ?? 'unmapped'} has no observed lineage`
      : l.permit_state !== 'consumed' || !consumption ? `lineage ${l.lineage_id} shows no permit consumption`
      : probes[consumption.probe].step !== own.i ? `the consumption of lineage ${l.lineage_id} is first shown at step ${probes[consumption.probe].step}, the start is step ${own.i}`
      : l.execution_id !== entry.execution_id ? `the consumption of lineage ${l.lineage_id} names execution ${l.execution_id ?? 'none'}, the start ran ${entry.execution_id}`
      : l.start_request_id !== (own.call!.request_id ?? null) ? `the consumption of lineage ${l.lineage_id} names start request ${l.start_request_id ?? 'none'}, step ${own.i} submitted ${own.call!.request_id ?? 'none'}`
      : null;
    if (why) missing.push({ probe: Math.max(at, 0), execution: entry.label, authority, reason: `execution started with no permit consumption of its own: ${why}` });
  }
  return { identity: [...new Set(idIssues)], transitions: [...new Set(trIssues)], missing };
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
/**
 * Format 3: the lifecycle denial reasons that are a contract decision of their operation (the state requirement the
 * contract names: approve needs pending, issue needs approved, start needs an issued, unused permit). Any other
 * LifecycleDeniedError (a binding or snapshot mismatch, a provider error, expiry) is no contract answer: UNKNOWN.
 */
export const CONTRACT_LIFECYCLE_DENIALS: Record<'approve' | 'issue' | 'start', readonly string[]> = { approve: ['not_pending'], issue: ['not_approved'], start: ['permit_not_issued', 'permit_consumed'] };

export function decisionFromCall(step: Step, call: CallRecord | undefined): DecisionValue | undefined {
  if (step.op === 'finish' || step.op === 'seal') return undefined;
  if (!call) return undefined;
  // Format 3 lifecycle calls (approve, issuePermit, start): a receipt or a started tool is ALLOW; an
  // AuthorityRevokedError or a contract lifecycle denial is DENY; anything else, or another API, is UNKNOWN.
  const lifecycleDeny = (op: 'approve' | 'issue' | 'start') => (call.outcome === 'threw' || call.outcome === 'rejected') && (call.class === 'AuthorityRevokedError' || (call.class === 'LifecycleDeniedError' && CONTRACT_LIFECYCLE_DENIALS[op].includes(call.reason ?? '')));
  if (call.api === 'approve' || call.api === 'issuePermit' || call.api === 'start' || step.op === 'issue') {
    const op = step.op === 'approve' ? 'approve' : step.op === 'issue' ? 'issue' : step.op === 'start' ? 'start' : null;
    if (op === null || PERMIT_API[op] !== call.api) return 'UNKNOWN';
    if (op === 'start') return call.outcome === 'tool_invoked' ? 'ALLOW' : lifecycleDeny(op) ? 'DENY' : 'UNKNOWN';
    return call.outcome === 'returned' ? 'ALLOW' : lifecycleDeny(op) ? 'DENY' : 'UNKNOWN';
  }
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
export function bindingIssues(authorities: Authority[], probes: Probe[], identity: IdentityMapping, format3?: { steps: Step[]; calls: CallRecord[] }): string[] {
  const issues = new Set<string>();
  for (const p of probes) for (const x of p.state.executions) {
    // Format 3: an execution's label is that of the start step whose fresh start request the runtime ran.
    if (format3) {
      const own = format3.calls.filter(c => c.api === 'start' && c.request_id === x.request_id).map(c => format3.steps[c.step]);
      if (own.length !== 1 || own[0]?.op !== 'start' || own[0].execution !== x.label) issues.add(`execution ${x.label} runs the start request ${String(x.request_id)}, which is not the start request of a step starting ${x.label}`);
    }
    const a = authorities.find(y => y.id === identity.capabilities[x.capability_id]);
    if (!a) continue;
    const tenant = x.tenant_id == null ? null : identity.tenants?.[x.tenant_id] ?? `unmapped:${x.tenant_id}`;
    if (tenant !== a.tenant) issues.add(`execution ${x.label} is bound to tenant ${JSON.stringify(tenant)}, its authority ${a.id} to ${a.tenant}`);
    const want = identity.chains?.[x.capability_id] ?? [];
    if (canonicalJson(x.ancestor_capability_ids ?? []) !== canonicalJson(want)) issues.add(`execution ${x.label} is bound to the chain ${JSON.stringify(x.ancestor_capability_ids ?? [])}, the supplied chain is ${JSON.stringify(want)}`);
  }
  return [...issues];
}
