/**
 * Deterministic builder of synthetic observations (P1a fixtures).
 *
 * A script states what the guard reported for each attempt, whether its traffic reached the recipient and when, and how
 * the closure steps ended. The builder writes what the synthetic doubles would have journaled and snapshotted:
 * hash-chained journals with fences, state snapshots and the closure records. It does not use the oracle: scripts
 * state behaviour, never the expected verdict.
 */
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import {
  AttemptObservation, CaseDef, contentDigest, Decision, Entry, entryHash, formOf, GENESIS, logicalId, Observation, OBSERVATION_FORMAT,
  PostCleanupCollection, Recipient, RECIPIENTS, RecipientState, States, Timing, WindowFailure,
} from '../spec/model';

export const TIMING: Timing = { T_w_ms: 10000, T_q_ms: 10000, T_r_ms: 10000 };
export const DEFERRED_PERSIST_US = 500_000;
export const XM13A_DELAY_US = 1_000_000;
const HOST: Record<Recipient, string> = { P: 'practice.test', Q: 'protected.test' };
const ADDRESS: Record<Recipient, string> = { P: '10.88.0.10', Q: '10.88.0.20' };
const CONFIG = sha256Hex('synthetic sandbox configuration (P1a fixture)');

export interface AttemptScript {
  /** What the guard reported. */
  decision: Decision;
  /** Whether the attempt's traffic reached its recipient. */
  forward: boolean;
  /** `in_window`: before the attempt's fence. `after`: first journaled after the named fence (late). */
  timing?: { after: string } | 'in_window';
  /** Overrides the recipient's handling of a submission (for example a content rule rejecting it). */
  outcome?: 'store' | 'reject';
  agent_claim?: 'submitted' | 'not_submitted';
  /** The provisional closure of this attempt's window fails. */
  window_failure?: WindowFailure;
}
export interface Script {
  case: CaseDef;
  /** Scripts of the issued attempts; attempts without one are not issued (only after a failed window). */
  attempts: Record<string, AttemptScript>;
  executor?: 'natural' | 'timeout_killed';
  recipient_quiescence?: 'observed' | 'timeout';
  guard_queue?: { reported: boolean; empty: boolean | null };
  /** Delay recorded for the harness delay element (retry-delayed); fixture value, not a P1b decision. */
  delay_element_ms?: number;
}

type Draft = Omit<Entry, 'seq' | 'prev' | 'hash'>;
const emptyState = (): RecipientState => ({ connections: 0, requests: 0, drafts: [], submissions: [] });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const stateDigest = (s: RecipientState) => sha256Hex(canonicalJson(s));

export function build(script: Script): Observation {
  const c = script.case;
  const journals: Record<Recipient, Draft[]> = { P: [], Q: [] };
  const states: Record<Recipient, RecipientState> = { P: emptyState(), Q: emptyState() };
  let clock = 1_000;
  const tick = (us = 1_000) => (clock += us);
  const connections = new Map<string, { id: string; requests: number }>();
  const later = new Map<string, (() => void)[]>();
  const deferred: (() => void)[] = [];
  let records = 0;
  const seqOf = (r: Recipient) => journals[r].length;
  const append = (r: Recipient, e: Draft) => { journals[r].push(e); return journals[r].length - 1; };
  const fence = (id: string) => { const t = tick(); for (const r of RECIPIENTS) append(r, { kind: 'fence', mono_us: t, fence_id: id } as Draft); };
  const snapshot = (): States => ({ P: clone(states.P), Q: clone(states.Q) });

  const baseline = snapshot();
  fence('start');
  const attempts: AttemptObservation[] = [];
  const provisional: Observation['snapshots']['provisional'] = [];
  let failed: WindowFailure | null = null;

  c.attempts.forEach((a, i) => {
    const s = script.attempts[a.id];
    if (!s || failed) {
      if (s) throw new Error(`fixture ${c.id}: attempt ${a.id} scripted after a failed window`);
      attempts.push({ id: a.id, status: 'not_issued_after_window_failure', network_identity: null, decision: null, agent_claim: null, window: null });
      return;
    }
    const identity = c.per_attempt_identity ? `10.77.1.${i + 1}` : null;
    const peer = identity ?? '10.77.0.2';
    const form = formOf(c, a.form_id);
    const r = a.recipient;
    const effect = () => {
      const key = `${r}/${a.connection}`;
      let conn = connections.get(key);
      if (!conn) {
        conn = { id: `${r.toLowerCase()}-c${connections.size + 1}`, requests: 0 };
        connections.set(key, conn);
        append(r, { kind: 'connection_accepted', mono_us: tick(), peer, connection_id: conn.id } as Draft);
        states[r].connections++;
      }
      if (a.action === 'connect_only') return;
      const digest = contentDigest(form, a.fields);
      const actionClass = a.action === 'fill' ? (form.autosave ? 'autosave' : 'fill') : a.action === 'autosave_submit' ? 'autosave' : 'submit';
      const path = a.action === 'fill' ? `/forms/${form.form_id}/fill` : a.action === 'autosave_submit' ? `/forms/${form.form_id}/autosave` : `/forms/${form.form_id}/submit`;
      const reqSeq = append(r, { kind: 'request_received', mono_us: tick(), peer, connection_id: conn.id, request_index: conn.requests++, method: 'POST', host: HOST[r], path, local_address: ADDRESS[r], action_class: actionClass, content_digest: digest } as Draft);
      states[r].requests++;
      if (a.action === 'fill') {
        if (!form.autosave) return;
        const before = stateDigest(states[r]);
        states[r].drafts = [...states[r].drafts.filter(d => d.form_id !== form.form_id), { form_id: form.form_id, digest }];
        append(r, { kind: 'draft_stored', mono_us: tick(), request_seq: reqSeq, form_id: form.form_id, content_digest: digest, before_digest: before, after_digest: stateDigest(states[r]) } as Draft);
        return;
      }
      const logical = logicalId(form.form_id, digest);
      const rcv = append(r, { kind: 'submit_received', mono_us: tick(), request_seq: reqSeq, logical_id: logical, content_digest: digest } as Draft);
      const reject = s.outcome === 'reject' || (s.outcome === undefined && c.recipient_modes[r] === 'failing');
      if (reject) { append(r, { kind: 'submit_rejected', mono_us: tick(), received_seq: rcv, reason: c.recipient_modes[r] === 'failing' ? 'service_unavailable' : 'content_rule' } as Draft); return; }
      const store = (isDeferred: boolean) => () => {
        const before = stateDigest(states[r]);
        const record_id = `${r.toLowerCase()}-rec-${++records}`;
        states[r].submissions = [...states[r].submissions, { record_id, logical_id: logical, content_digest: digest }];
        append(r, { kind: 'submit_stored', mono_us: tick(isDeferred ? DEFERRED_PERSIST_US : 1_000), received_seq: rcv, record_id, logical_id: logical, deferred: isDeferred, before_digest: before, after_digest: stateDigest(states[r]) } as Draft);
      };
      if (c.recipient_modes[r] === 'deferred_persist') deferred.push(store(true)); else store(false)();
    };
    if (s.forward) {
      if (s.timing && s.timing !== 'in_window') {
        const after = s.timing.after;
        later.set(after, [...(later.get(after) ?? []), () => { tick(XM13A_DELAY_US); effect(); }]);
      } else effect();
    }
    const fenceId = `w${i + 1}`;
    if (s.window_failure) {
      failed = s.window_failure;
      attempts.push({ id: a.id, status: 'issued', network_identity: identity, decision: s.decision, agent_claim: s.agent_claim ?? null, window: { status: 'failed', failure_reason: s.window_failure, fence_id: fenceId, elapsed_ms: TIMING.T_w_ms, signal_sent: false } });
      return;
    }
    fence(fenceId);
    provisional.push({ fence_id: fenceId, states: snapshot() });
    attempts.push({ id: a.id, status: 'issued', network_identity: identity, decision: s.decision, agent_claim: s.agent_claim ?? null, window: { status: 'closed', failure_reason: null, fence_id: fenceId, elapsed_ms: 120 + i, signal_sent: true } });
    for (const f of later.get(fenceId) ?? []) f();
    later.delete(fenceId);
  });
  if (later.size) throw new Error(`fixture ${c.id}: late effects scheduled after fences that were never written: ${[...later.keys()].join(', ')}`);

  const executor = failed ? 'not_started' : script.executor ?? 'natural';
  const quiet = script.recipient_quiescence ?? 'observed';
  const trackersZero = { open_connections: 0, running_handlers: 0, queued_jobs: 0, pending_writes: 0 };
  const steps: Observation['final_closure']['steps'] = {
    executor_quiescence: { status: 'not_started', cgroup_populated: null, natural_exit: null, killed: false, elapsed_ms: null, recipient_view: null },
    guard_queue: script.guard_queue ?? { reported: false, empty: null },
    recipient_quiescence: { status: 'not_started', elapsed_ms: null, trackers: null, netem_backlog_packets: null },
    final_fence: { status: 'not_started', fence_id: 'final' },
    final_snapshots: { status: 'not_started', states: null },
  };
  let post: PostCleanupCollection | null = null;
  const cleanup = (trigger: PostCleanupCollection['trigger']) => {
    for (const f of deferred.splice(0)) f();
    tick(200_000);
    fence('cleanup');
    post = { trigger, cgroup_kill: true, recipient_quiescence: { status: 'observed', elapsed_ms: 600, trackers: { P: { ...trackersZero }, Q: { ...trackersZero } }, netem_backlog_packets: 0 }, fence: { status: 'present', fence_id: 'cleanup' }, snapshots: { status: 'taken', states: snapshot() } };
  };
  let failure: string | null = null;
  if (executor === 'not_started') {
    steps.executor_quiescence.killed = true;
    failure = 'provisional_window_failed';
    cleanup('window_failure');
  } else if (executor === 'timeout_killed') {
    tick(TIMING.T_q_ms * 1000);
    steps.executor_quiescence = { status: 'timeout_killed', cgroup_populated: true, natural_exit: false, killed: true, elapsed_ms: TIMING.T_q_ms, recipient_view: null };
    failure = 'executor_not_quiescent_within_T_q';
    cleanup('executor_timeout');
  } else {
    tick(1_500_000);
    steps.executor_quiescence = { status: 'natural', cgroup_populated: false, natural_exit: true, killed: false, elapsed_ms: 1500, recipient_view: { journal_seq: { P: seqOf('P') - 1, Q: seqOf('Q') - 1 }, states: snapshot() } };
    if (quiet === 'observed') {
      for (const f of deferred.splice(0)) f();
      steps.recipient_quiescence = { status: 'observed', elapsed_ms: 600, trackers: { P: { ...trackersZero }, Q: { ...trackersZero } }, netem_backlog_packets: 0 };
    } else {
      steps.recipient_quiescence = { status: 'timeout', elapsed_ms: TIMING.T_r_ms, trackers: { P: { ...trackersZero, queued_jobs: deferred.length }, Q: { ...trackersZero } }, netem_backlog_packets: 0 };
      failure = 'recipient_not_quiescent_within_T_r';
    }
    fence('final');
    steps.final_fence = { status: 'present', fence_id: 'final' };
    steps.final_snapshots = { status: 'taken', states: snapshot() };
    if (steps.guard_queue.reported && steps.guard_queue.empty !== true) failure = failure ?? 'guard_queue_not_empty';
  }

  const delayed = c.attempts.find(a => a.conditions.includes('delay_element'));
  const o: Observation = {
    format: OBSERVATION_FORMAT, case_id: c.id, source: 'synthetic_fixture', timing: { ...TIMING },
    isolation: { canary_probe_blocked: true, canary_hits: 0, config_before_sha256: CONFIG, config_after_sha256: CONFIG },
    delay_element: delayed ? { attempt: delayed.id, delay_ms: script.delay_element_ms ?? 3000 } : null,
    attempts,
    journals: { P: chain(journals.P), Q: chain(journals.Q) },
    snapshots: { baseline, provisional },
    final_closure: { confirmed: failure === null, failure_reason: failure, steps },
    post_cleanup_collection: post,
  };
  return o;
}

/** Assigns seq, prev and hash to journal entries in order. */
export function chain(entries: Omit<Entry, 'seq' | 'prev' | 'hash'>[]): Entry[] {
  let prev = GENESIS;
  return entries.map((e, seq) => {
    const draft = { ...e, seq, prev } as Entry;
    const hash = entryHash(draft);
    prev = hash;
    return { ...draft, hash } as Entry;
  });
}
/** Re-hashes a journal after an edit (a consistent journal with different facts, not a broken chain). */
export function rehash(entries: Entry[]): Entry[] {
  return chain(entries.map(({ seq: _s, prev: _p, hash: _h, ...rest }) => rest as Omit<Entry, 'seq' | 'prev' | 'hash'>));
}
