/**
 * Canonical comparison form of a P1b case run for double-run determinism (decisions, "Canonical comparison form").
 *
 * Replaced explicitly: the run id (dropped), clock readings (a journal entry's `mono_us` becomes the number of
 * attempts issued before it; an elapsed time becomes its comparison with its bound; timeline readings become their
 * presence) and the per-run names, MAC addresses and the netem random seed inside the configuration texts. Dropped: entry hashes and `prev`
 * (the chain is verified first). Kept unchanged: order within each journal and per attempt, sequence numbers, kinds,
 * peers, connection, request and record ids, digests, logical ids, fences, states, decisions, late answers, window
 * statuses, attribution, findings, gaps and errors. The raw observations are never modified.
 */
import { canonicalJson } from '../../util/canonical-json';
import { Entry, entryHash, Evidence, GENESIS, Observation } from '../spec/model';
import type { RunRecord } from './record';

export function normalizeConfig(text: string): string {
  return text.replace(/\/run\/ea(-exec|-code)?\/[0-9a-f]{6}/g, '/run/ea$1/<rid>').replace(/ea[0-9a-f]{6}/g, 'ea<rid>').replace(/([0-9a-f]{2}:){5}[0-9a-f]{2}/g, '<mac>').replace(/\bseed \d+/g, 'seed <seed>');
}
const chainOk = (j: Entry[]) => { let prev = GENESIS; return j.every((e, i) => { const ok = e.seq === i && e.prev === prev && entryHash(e) === e.hash; prev = e.hash; return ok; }); };

export function canonicalCase(observation: unknown, recordIn: unknown, evidence: Evidence | null, bounds: { T_w_ms: number; T_q_ms: number; T_r_ms: number }): unknown {
  const o = observation as Observation;
  const rec = recordIn as RunRecord;
  if (!o || !Array.isArray(o.attempts) || !rec || !rec.timeline) return { malformed: true, observation, evidence };
  const issued = rec.timeline.attempts.map(a => a.issued_us).filter((x): x is number => x !== null);
  const before = (us: number) => issued.filter(x => x < us).length;
  const journal = (j: Entry[] | null) => j === null ? null : { chain_ok: chainOk(j), entries: j.map(({ hash: _h, prev: _p, mono_us, ...rest }) => ({ ...rest, attempts_issued_before: before(mono_us) })) };
  const within = (ms: number | null, bound: number) => ms === null ? null : ms <= bound ? 'within_bound' : 'over_bound';
  const steps = o.final_closure.steps;
  const obs = {
    ...o,
    isolation: { ...o.isolation, config_before_sha256: undefined, config_after_sha256: undefined, config_unchanged: o.isolation.config_before_sha256 === o.isolation.config_after_sha256 },
    attempts: o.attempts.map(a => ({ ...a, window: a.window ? { ...a.window, elapsed_ms: within(a.window.elapsed_ms, bounds.T_w_ms) } : null })),
    journals: { P: journal(o.journals.P), Q: journal(o.journals.Q) },
    final_closure: { ...o.final_closure, steps: { ...steps, executor_quiescence: { ...steps.executor_quiescence, elapsed_ms: within(steps.executor_quiescence.elapsed_ms, bounds.T_q_ms) }, recipient_quiescence: { ...steps.recipient_quiescence, elapsed_ms: within(steps.recipient_quiescence.elapsed_ms, bounds.T_r_ms) } } },
    post_cleanup_collection: o.post_cleanup_collection ? { ...o.post_cleanup_collection, recipient_quiescence: { ...o.post_cleanup_collection.recipient_quiescence, elapsed_ms: within(o.post_cleanup_collection.recipient_quiescence.elapsed_ms, bounds.T_r_ms) } } : null,
  };
  const t = rec.timeline;
  const record = {
    case_id: rec.case_id, guard: rec.guard,
    attempts: t.attempts.map(a => ({ id: a.id, issued: a.issued_us !== null, answer: a.answer ? { decision: a.answer.decision, status: a.answer.status } : null, timed_out: a.timeout_at_us !== null, recorded_decision: a.recorded_decision, late_answers: a.late_answers.map(x => ({ decision: x.decision, status: x.status })), cancel_sent: a.cancel_sent_us !== null })),
    windows: t.windows.map(w => ({ fence_id: w.fence_id, attempts: w.attempts, status: w.status, failure_reason: w.failure_reason, signal_sent: w.signal_sent_us !== null })),
    steps: { t_q_started: t.t_q_start_us !== null, executor_quiescent: t.executor_quiescent_us !== null, recipient_quiescent: t.recipient_quiescent_us !== null, final_fence: t.final_fence_us !== null, cleanup: t.cleanup_us !== null },
    // Events are ordered per attempt (causal order); signals in their own order; the interleaving of independent channels is not compared.
    guard_events: Object.fromEntries([...new Set(rec.guard_events.map(g => g.attempt ?? '-'))].sort().map(k => [k, rec.guard_events.filter(g => (g.attempt ?? '-') === k).map(g => ({ event: g.event, detail: g.detail }))])),
    executor_processes: [...rec.executor_processes].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ name: p.name, code: p.code, signal: p.signal, killed_by_cleanup: p.killed_by_cleanup })),
    protocol_errors: rec.protocol_errors,
    isolation: {
      probes: rec.isolation.probes.map(p => ({ ns: p.ns, results: p.results.map(r => ({ name: r.name, target: normalizeConfig(r.target), blocked: r.blocked })) })),
      config_before: normalizeConfig(rec.isolation.config_before).split('\n'), config_unchanged: rec.isolation.config_after_sha256 === rec.isolation.config_before_sha256,
      drop_counters_before: rec.isolation.drop_counters_before, drop_counters_after: rec.isolation.drop_counters_after,
      canary_hits: rec.isolation.canary_hits.length, netem: rec.isolation.netem.map(n => ({ dev: normalizeConfig(n.dev), delay_us: n.delay_us })),
      channel: rec.isolation.channel,
    },
    errors: rec.errors.map(x => ({ code: x.code, message: normalizeConfig(x.message) })),
  };
  return JSON.parse(canonicalJson({ observation: JSON.parse(JSON.stringify(obs)), record, evidence }));
}
export const canonicalBytes = (x: unknown) => canonicalJson(x) + '\n';
