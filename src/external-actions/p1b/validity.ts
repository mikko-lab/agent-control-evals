/**
 * P1b run validity (decisions, "Run record"): checks of what the harness itself recorded about a case run, beside
 * the evaluator's checks of the observation. Any failure is a technical error of the case (HARNESS_ERROR, exit 2):
 * isolation probes, canary, configuration and counters, the observation channel, executor and protocol errors, the
 * `retry-after-unsent` hook and the `retry-delayed` order proof.
 */
import type { Entry, Observation } from '../spec/model';
import type { CasePlan, RunConfig } from './config';
import { RUN_RECORD_FORMAT, RunRecord } from './record';

export interface ValidityError { code: string; path: string; message: string }
const PROBES = ['canary_tcp', 'canary_dns', 'no_route', 'filtered_port', 'observation_channel_hidden'];

export function runValidity(plan: CasePlan, config: RunConfig, observation: unknown, recordIn: unknown): ValidityError[] {
  const out: ValidityError[] = [];
  const e = (code: string, path: string, message: string) => out.push({ code, path, message });
  const rec = recordIn as RunRecord & { missing?: boolean };
  if (!rec || rec.format !== RUN_RECORD_FORMAT || rec.missing || rec.case_id !== plan.case_id) {
    e('run_record_missing', '/run_record', `no valid run record for ${plan.case_id}`);
    for (const x of (rec?.errors ?? [])) e(`harness_${x.code}`, '/run_record/errors', x.message);
    return out;
  }
  for (const x of rec.errors) e(`harness_${x.code}`, '/run_record/errors', x.message);
  for (const x of rec.protocol_errors) e('protocol_error', '/run_record/protocol_errors', x);
  const EXECUTOR_ERRORS = ['guard_error', 'protocol_error', 'cancel_without_hold', 'forward_without_attempt', 'forward_no_forwarder', 'forward_rejected', 'after_signal_without_attempt', 'descendant_creation_allowed', 'descendant_creation_denied'];
  for (const g of rec.guard_events) if (EXECUTOR_ERRORS.includes(g.event)) e('executor_error', '/run_record/guard_events', `${g.event} ${g.attempt ?? ''} ${JSON.stringify(g.detail)}`);
  // Descendant-process creation must be prevented, so that executor quiescence over the harness-started processes
  // covers the whole process tree (decisions, "Executor quiescence"). The executor reports the prevention at startup.
  const guardEnv = rec.guard_events.find(g => g.event === 'env_guard')?.detail as { child_process_denied?: unknown; worker_denied?: unknown } | undefined;
  if (!guardEnv || guardEnv.child_process_denied !== true || guardEnv.worker_denied !== true) e('descendant_prevention_missing', '/run_record/guard_events', `the executor did not confirm that child-process and worker creation are denied (${JSON.stringify(guardEnv ?? null)})`);
  const o = observation as Observation | null;
  if (!o || o.source !== 'local_doubles') e('observation_source', '/observation/source', 'a P1b observation must come from the local doubles');

  // Isolation.
  const iso = rec.isolation;
  if (iso.probes.length !== plan.identities.length) e('isolation_probe_missing', '/run_record/isolation/probes', `probes ran in ${iso.probes.length} executor namespaces, the case has ${plan.identities.length}`);
  for (const p of iso.probes) {
    const names = p.results.map(r => r.name);
    for (const n of PROBES) if (!names.includes(n)) e('isolation_probe_missing', `/run_record/isolation/probes/${p.ns}`, `probe ${n} did not run`);
    for (const r of p.results) if (!r.blocked) e('isolation_probe_failed', `/run_record/isolation/probes/${p.ns}`, `${r.name} ${r.target}: ${r.detail}`);
  }
  if (iso.canary_hits.length) e('canary_hit', '/run_record/isolation/canary_hits', `${iso.canary_hits.length} canary hit(s)`);
  if (iso.config_after_sha256 === null) e('isolation_after_missing', '/run_record/isolation', 'no configuration record after the case');
  else if (iso.config_after_sha256 !== iso.config_before_sha256) {
    const a = iso.config_before.split('\n'), b = (iso.config_after ?? '').split('\n');
    const changed = [...a.filter(l => !b.includes(l)).map(l => `- ${l.trim()}`), ...b.filter(l => !a.includes(l)).map(l => `+ ${l.trim()}`)].slice(0, 12);
    e('isolation_changed', '/run_record/isolation', `the isolation configuration changed during the case: ${changed.join(' | ')}`);
  }
  if (!iso.drop_counters_after) e('isolation_after_missing', '/run_record/isolation', 'no drop counters after the case');
  else {
    const keys = new Set([...Object.keys(iso.drop_counters_before), ...Object.keys(iso.drop_counters_after)]);
    for (const k of keys) if (iso.drop_counters_after[k] !== iso.drop_counters_before[k]) e('drop_counter_changed', '/run_record/isolation', `drop counter ${k}: ${iso.drop_counters_before[k]} -> ${iso.drop_counters_after[k]}`);
  }
  // Observation channel: owned by the doubles' user, readable by the harness reader's group, writable by no one else.
  const ch = iso.channel;
  const owned = (what: string, m: { owner: string; group: string; mode: string }, mode: string) => {
    if (m.owner !== ch.expected.owner || m.group !== ch.expected.group || m.mode !== mode) e('observation_channel_unprotected', '/run_record/isolation/channel', `${what}: owner ${m.owner}, group ${m.group}, mode ${m.mode}; expected ${ch.expected.owner}:${ch.expected.group} ${mode}`);
  };
  if (!ch || !ch.expected) e('observation_channel_unprotected', '/run_record/isolation/channel', 'no observation channel record');
  else {
    owned('journal directory', ch.journal_dir, '2750');
    owned('control directory', ch.ctl_dir, '2750');
    for (const f of ch.journal_files) owned(`journal ${f.recipient}`, f, '640');
    for (const f of ch.ctl_sockets) owned(`control socket ${f.recipient}`, f, '660');
  }

  // Executor processes: an exit that is not natural and not caused by the cleanup is an executor failure.
  for (const p of rec.executor_processes) if ((p.code !== 0 || p.signal !== null) && !p.killed_by_cleanup) e('executor_process_failed', '/run_record/executor_processes', `${p.name} exited with code ${p.code}, signal ${p.signal}`);

  const tl = (id: string) => rec.timeline.attempts.find(a => a.id === id);
  // retry-after-unsent: the hook held the attempt and the cancel ended it.
  for (const a of plan.attempts) if (a.hook) {
    const ev = rec.guard_events.filter(g => g.attempt === a.request.id).map(g => g.event);
    const t = tl(a.request.id);
    if (!ev.includes('hook_holding') || !ev.includes('hook_cancelled') || !t || t.recorded_decision !== 'UNKNOWN' || t.cancel_sent_us === null || ev.some(x => x.startsWith('forward_'))) e('hook_not_applied', '/run_record/guard_events', `the hold-before-forward hook of ${a.request.id} did not hold and cancel it (${ev.join(', ')})`);
  }
  // retry-delayed: the order is proven from the observations, not from the configured delay.
  if (plan.delay_element) {
    const d = plan.delay_element;
    const first = plan.attempts.find(a => a.request.id === d.attempt)!;
    const retry = plan.attempts[plan.attempts.indexOf(first) + 1];
    const t1 = tl(d.attempt), t2 = retry ? tl(retry.request.id) : undefined;
    const fail = (why: string) => e('retry_delayed_order_not_proven', '/run_record/timeline', why);
    if (!iso.netem.some(n => n.delay_us === d.delay_ms * 1000)) fail(`no ${d.delay_ms} ms netem delay element in the doubles' namespace`);
    if (!t1 || !t2 || t1.issued_us === null || t2.issued_us === null) fail('the first attempt or its retry was not issued');
    else {
      const fwd = rec.guard_events.find(g => g.attempt === d.attempt && g.event === 'forward_started');
      if (!fwd || fwd.at_us >= t2.issued_us) fail('the guard did not report forwarding the first attempt before the retry was issued');
      const w1 = rec.timeline.windows.find(w => w.attempts.includes(d.attempt));
      if (!w1 || w1.status !== 'closed') fail("the first attempt's provisional closure did not succeed");
      if (t1.recorded_decision !== 'UNKNOWN' || t1.timeout_at_us === null) fail('the first attempt did not time out');
      else if (t2.issued_us - t1.timeout_at_us > config.timing.retry_start_limit_ms * 1000) fail(`the retry started ${Math.round((t2.issued_us - t1.timeout_at_us) / 1000)} ms after the first attempt's timeout, more than ${config.timing.retry_start_limit_ms} ms`);
      const j = o?.journals?.[first.request.recipient] as Entry[] | null | undefined;
      const fenceSeq = j?.find(x => x.kind === 'fence' && w1 && x.fence_id === w1.fence_id)?.seq;
      const mine = (j ?? []).filter(x => (x.kind === 'connection_accepted' || x.kind === 'request_received') && x.peer === first.network_identity);
      if (!j || mine.length === 0) fail("no journal entry with the first attempt's identity: its effect never appeared");
      else if (mine.some(x => x.mono_us <= t2.issued_us! || fenceSeq === undefined || x.seq <= fenceSeq)) fail("an entry with the first attempt's identity was journaled before the retry was issued or before its window's fence");
    }
  }
  return out;
}
