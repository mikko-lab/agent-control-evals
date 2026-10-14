/**
 * P1b case runner: the scripted driver and the observation collector of one case. Runs as the harness reader H in the
 * harness namespace (loopback only). It talks to the doubles over their control sockets, reads their journal files,
 * reads the case cgroup's events and writes its `cgroup.kill` for cleanup, and reaches the executor only through the
 * root orchestrator (stdin and stdout, one JSON object per line).
 *
 *   node case-runner.js CONFIG.json
 *
 * To the orchestrator: { type: 'to_executor', msg }, { type: 'signal', fence_id, attempts }, { type: 'end_executor' },
 *   { type: 'kill_note' }, { type: 'case_done' }.
 * From the orchestrator: { type: 'from_executor', msg, at_us }, { type: 'exit', name, code, signal, at_us },
 *   { type: 'isolation', ... } (before the case), { type: 'isolation_after', ... }.
 *
 * Every interval is measured here on CLOCK_MONOTONIC. The bounds are the pinned ones and are never extended.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, Socket } from 'node:net';
import { join } from 'node:path';
import { canonicalJson } from '../../util/canonical-json';
import {
  AttemptObservation, Entry, FinalClosure, Observation, OBSERVATION_FORMAT, PostCleanupCollection, Recipient, RecipientQuiescence, RecipientState,
  States, Tracker,
} from '../spec/model';
import type { CasePlan } from './config';
import { AttemptTimeline, RUN_RECORD_FORMAT, RunRecord, WindowTimeline } from './record';

export interface CaseRunnerConfig {
  run_id: string;
  plan: CasePlan;
  guard: { id: string; sha256: string };
  timing: { T_w_ms: number; T_q_ms: number; T_r_ms: number; driver_answer_timeout_ms: number; retry_start_limit_ms: number; poll_interval_ms: number };
  ctl: Record<Recipient, string>;
  journals: Record<Recipient, string>;
  canary_journal: string;
  netem_socket: string;
  cgroup_dir: string;
  out_dir: string;
  executor_processes: string[];
}

const RECIPIENTS: Recipient[] = ['P', 'Q'];
const nowUs = (): number => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const send = (m: Record<string, unknown>) => process.stdout.write(JSON.stringify(m) + '\n');

/** A line-protocol client with one request in flight at a time and a bounded wait. */
class LineClient {
  private socket: Socket | null = null;
  private buf = '';
  private waiter: ((v: Record<string, unknown> | null) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private open(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(true);
    return new Promise(resolve => {
      const s = connect(this.path);
      s.once('connect', () => { this.socket = s; resolve(true); });
      s.once('error', () => resolve(false));
      s.on('data', d => {
        this.buf += d.toString('utf8');
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
          const w = this.waiter; this.waiter = null;
          try { w?.(JSON.parse(line)); } catch { w?.(null); }
        }
      });
      s.on('close', () => { const w = this.waiter; this.waiter = null; w?.(null); });
    });
  }
  request(q: Record<string, unknown>, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
    const p = this.queue.then(async () => {
      if (!(await this.open())) return null;
      return new Promise<Record<string, unknown> | null>(resolve => {
        const t = setTimeout(() => { this.waiter = null; resolve(null); }, timeoutMs);
        this.waiter = v => { clearTimeout(t); resolve(v); };
        this.socket!.write(JSON.stringify(q) + '\n');
      });
    });
    this.queue = p.catch(() => null);
    return p;
  }
  close() { this.socket?.destroy(); }
}

async function main() {
  const cfg: CaseRunnerConfig = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const { plan, timing } = cfg;
  const errors: RunRecord['errors'] = [];
  const err = (code: string, message: string) => errors.push({ code, message });
  const ctl = { P: new LineClient(cfg.ctl.P), Q: new LineClient(cfg.ctl.Q) };
  const netem = new LineClient(cfg.netem_socket);

  // Messages from the orchestrator.
  const guardEvents: RunRecord['guard_events'] = [];
  const exits: RunRecord['executor_processes'] = [];
  const protocolErrors: string[] = [];
  const answers = new Map<string, { decision: string; status: number | null; at_us: number }[]>();
  let isolationBefore: Record<string, unknown> | null = null;
  let isolationAfter: Record<string, unknown> | null = null;
  let killed = false;
  {
    let buf = '';
    process.stdin.on('data', d => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: Record<string, unknown>;
        try { m = JSON.parse(line); } catch { protocolErrors.push('orchestrator sent an unparsable line'); continue; }
        if (m.type === 'from_executor') {
          const x = m.msg as Record<string, unknown>;
          const at = Number(m.at_us);
          if (x.type === 'answer') {
            const id = String(x.attempt);
            const list = answers.get(id) ?? [];
            list.push({ decision: String(x.decision), status: typeof x.status === 'number' ? x.status : null, at_us: at });
            answers.set(id, list);
          } else if (x.type === 'event') guardEvents.push({ event: String(x.event), attempt: x.attempt === null ? null : String(x.attempt), detail: x.detail ?? null, at_us: at });
          else protocolErrors.push(`executor message of unknown type ${String(x.type)}`);
        } else if (m.type === 'exit') exits.push({ name: String(m.name), code: typeof m.code === 'number' ? m.code : null, signal: typeof m.signal === 'string' ? m.signal : null, at_us: Number(m.at_us), killed_by_cleanup: killed });
        else if (m.type === 'protocol_error') protocolErrors.push(String(m.message));
        else if (m.type === 'isolation') isolationBefore = m;
        else if (m.type === 'isolation_after') isolationAfter = m;
      }
    });
  }
  const waitFor = async (pred: () => boolean, deadlineUs: number) => { while (!pred()) { if (nowUs() >= deadlineUs) return pred(); await sleep(timing.poll_interval_ms); } return true; };
  await waitFor(() => isolationBefore !== null, nowUs() + 60_000_000);

  const fence = async (id: string): Promise<null | Record<Recipient, { seq: number; state: RecipientState }>> => {
    const r = await Promise.all(RECIPIENTS.map(x => ctl[x].request({ op: 'fence', id })));
    if (r.some(x => !x || x.ok !== true)) { err('fence_failed', `fence ${id}: ${JSON.stringify(r)}`); return null; }
    return { P: { seq: Number(r[0]!.seq), state: r[0]!.state as RecipientState }, Q: { seq: Number(r[1]!.seq), state: r[1]!.state as RecipientState } };
  };
  const trackers = async (): Promise<Record<Recipient, Tracker> | null> => {
    const r = await Promise.all(RECIPIENTS.map(x => ctl[x].request({ op: 'tracker' })));
    if (r.some(x => !x || x.ok !== true)) return null;
    return { P: r[0]!.tracker as Tracker, Q: r[1]!.tracker as Tracker };
  };
  const backlog = async (): Promise<number | null> => { const r = await netem.request({ op: 'backlog' }, 3000); return r && r.ok === true && typeof r.backlog_packets === 'number' ? r.backlog_packets : null; };
  const populated = (): boolean | null => {
    try { const m = /populated (\d)/.exec(readFileSync(join(cfg.cgroup_dir, 'cgroup.events'), 'utf8')); return m ? m[1] === '1' : null; } catch { return null; }
  };
  const kill = () => { try { writeFileSync(join(cfg.cgroup_dir, 'cgroup.kill'), '1'); killed = true; send({ type: 'kill_note' }); return true; } catch (e) { err('cgroup_kill_failed', String(e)); return false; } };
  const zero = (t: Tracker) => t.open_connections === 0 && t.running_handlers === 0 && t.queued_jobs === 0 && t.pending_writes === 0;
  const states = (f: Record<Recipient, { state: RecipientState }>): States => ({ P: f.P.state, Q: f.Q.state });

  // Baseline at the start fence.
  const t: RunRecord['timeline'] = { start_fence_us: null, attempts: [], windows: [], t_q_start_us: null, executor_quiescent_us: null, t_r_start_us: null, recipient_quiescent_us: null, final_fence_us: null, cleanup_us: null };
  const start = await fence('start');
  t.start_fence_us = nowUs();
  const empty = (): RecipientState => ({ connections: 0, requests: 0, drafts: [], submissions: [] });
  const baseline: States = start ? states(start) : { P: empty(), Q: empty() };
  if (!start) err('baseline_failed', 'the start fence could not be written');

  const attempts: AttemptObservation[] = plan.attempts.map(a => ({ id: a.request.id, status: 'not_issued_after_window_failure', network_identity: null, decision: null, agent_claim: null, window: null }));
  const provisional: Observation['snapshots']['provisional'] = [];
  const tl = new Map<string, AttemptTimeline>(plan.attempts.map(a => [a.request.id, { id: a.request.id, issued_us: null, answer: null, timeout_at_us: null, recorded_decision: null, late_answers: [], cancel_sent_us: null }]));
  let failed = !start;

  for (const group of plan.groups) {
    if (failed) break;
    const issued = new Map<string, number>();
    for (const id of group) {
      const a = plan.attempts.find(x => x.request.id === id)!;
      const rec = tl.get(id)!;
      const at = nowUs();
      issued.set(id, at);
      rec.issued_us = at;
      send({ type: 'to_executor', msg: { type: 'attempt', request: a.request } });
      const deadline = at + timing.driver_answer_timeout_ms * 1000;
      const got = await waitFor(() => (answers.get(id)?.length ?? 0) > 0, deadline);
      const first = answers.get(id)?.[0];
      let decision: string;
      if (got && first && first.at_us <= deadline) { decision = first.decision; rec.answer = first; }
      else { decision = 'UNKNOWN'; rec.timeout_at_us = deadline; }
      if (decision !== 'ALLOW' && decision !== 'DENY' && decision !== 'UNKNOWN') { err('invalid_decision', `attempt ${id}: ${decision}`); decision = 'UNKNOWN'; }
      rec.recorded_decision = decision;
      if (decision === 'UNKNOWN' && a.hook === 'hold_before_forward') { send({ type: 'to_executor', msg: { type: 'cancel', attempt: id } }); rec.cancel_sent_us = nowUs(); }
      const idx = plan.attempts.indexOf(a);
      attempts[idx] = { id, status: 'issued', network_identity: a.network_identity, decision: decision as 'ALLOW' | 'DENY' | 'UNKNOWN', agent_claim: null, window: null };
    }
    // Provisional closure of the group's window (decisions: keep-alive group window), bounded by the earliest T_w.
    const fenceId = group.length === 1 ? `w${plan.attempts.findIndex(x => x.request.id === group[0]) + 1}` : `w${plan.attempts.findIndex(x => x.request.id === group[0]) + 1}-${plan.attempts.findIndex(x => x.request.id === group[group.length - 1]) + 1}`;
    const deadline = Math.min(...[...issued.values()].map(x => x + timing.T_w_ms * 1000));
    // A forward of this group that the executor has reported starting but not yet done is still in flight. The window
    // is fenced only once every such forward has settled, so a forward the guard kicked off before the fence — a normal
    // awaited send, a send whose response the recipient held, or a fire-and-forget send started under a reported DENY —
    // has by then reached the recipient and its effect is journaled before this fence. Without this the fire-and-forget
    // send races the fence and its effect is journaled after it only on some hosts, so the same guard would be judged
    // late or in-window by timing alone. The delay-element attempt is excluded on purpose: its traffic is held by the
    // netem element so its effect is observed after its own fence (the retry-delayed order proof), and waiting for it
    // would defeat that. A send the guard schedules for after the closure signal has not started here and stays late.
    // (decisions, "Provisional closure" and "retry-delayed".)
    const delayAttempt = plan.delay_element?.attempt;
    const waited = new Set(group.filter(id => id !== delayAttempt));
    const forwardsSettled = () => {
      let started = 0, done = 0;
      for (const g of guardEvents) {
        if (g.attempt === null || !waited.has(g.attempt)) continue;
        if (g.event === 'forward_started') started++; else if (g.event === 'forward_done') done++;
      }
      return started === done;
    };
    let reason: 'connections_open' | 'forward_in_flight' | 'fence_missing' | null = null;
    let closedAt: number | null = null;
    for (;;) {
      const tr = await trackers();
      if (tr && tr.P.open_connections === 0 && tr.Q.open_connections === 0 && forwardsSettled()) {
        const f = nowUs() < deadline ? await fence(fenceId) : null;
        if (f && nowUs() <= deadline) { provisional.push({ fence_id: fenceId, states: states(f) }); closedAt = nowUs(); break; }
        reason = 'fence_missing'; break;
      }
      if (nowUs() >= deadline) { reason = !tr ? 'fence_missing' : forwardsSettled() ? 'connections_open' : 'forward_in_flight'; break; }
      await sleep(timing.poll_interval_ms);
    }
    const w: WindowTimeline = { fence_id: fenceId, attempts: group, status: reason ? 'failed' : 'closed', failure_reason: reason, closed_at_us: closedAt, signal_sent_us: null };
    if (!reason) { send({ type: 'signal', fence_id: fenceId, attempts: group }); w.signal_sent_us = nowUs(); }
    t.windows.push(w);
    for (const id of group) {
      const idx = plan.attempts.findIndex(x => x.request.id === id);
      const elapsed = Math.round(((closedAt ?? deadline) - issued.get(id)!) / 1000);
      attempts[idx].window = { status: reason ? 'failed' : 'closed', failure_reason: reason, fence_id: fenceId, elapsed_ms: reason ? Math.max(elapsed, timing.T_w_ms) : elapsed, signal_sent: !reason };
    }
    if (reason) failed = true;
  }

  // Final closure (plan §5.4, D10) or cleanup.
  const steps: FinalClosure['steps'] = {
    executor_quiescence: { status: 'not_started', cgroup_populated: null, natural_exit: null, killed: false, elapsed_ms: null, recipient_view: null },
    guard_queue: { reported: false, empty: null },
    recipient_quiescence: { status: 'not_started', elapsed_ms: null, trackers: null, netem_backlog_packets: null },
    final_fence: { status: 'not_started', fence_id: 'final' },
    final_snapshots: { status: 'not_started', states: null },
  };
  let failure: string | null = null;
  let post: PostCleanupCollection | null = null;
  const recipientQuiescence = async (): Promise<RecipientQuiescence> => {
    const t0 = nowUs();
    const end = t0 + timing.T_r_ms * 1000;
    let tr: Record<Recipient, Tracker> | null = null, bl: number | null = null;
    for (;;) {
      tr = await trackers(); bl = await backlog();
      if (tr && zero(tr.P) && zero(tr.Q) && bl === 0) return { status: 'observed', elapsed_ms: Math.round((nowUs() - t0) / 1000), trackers: tr, netem_backlog_packets: bl };
      if (nowUs() >= end) return { status: 'timeout', elapsed_ms: timing.T_r_ms, trackers: tr, netem_backlog_packets: bl };
      await sleep(timing.poll_interval_ms);
    }
  };
  const cleanup = async (trigger: PostCleanupCollection['trigger']) => {
    if (!killed) kill();
    await waitFor(() => populated() === false, nowUs() + 5_000_000);
    t.cleanup_us = nowUs();
    const rq = await recipientQuiescence();
    const f = await fence('cleanup');
    post = { trigger, cgroup_kill: killed, recipient_quiescence: rq, fence: { status: f ? 'present' : 'missing', fence_id: 'cleanup' }, snapshots: f ? { status: 'taken', states: states(f) } : { status: 'failed', states: null } };
  };
  if (failed) {
    failure = 'provisional_window_failed';
    send({ type: 'end_executor' });
    await cleanup('window_failure');
    steps.executor_quiescence.killed = killed;
  } else {
    const t0 = nowUs();
    t.t_q_start_us = t0;
    send({ type: 'end_executor' });
    const naturalAll = () => cfg.executor_processes.every(n => exits.some(e => e.name === n));
    const ok = await waitFor(() => populated() === false && naturalAll(), t0 + timing.T_q_ms * 1000);
    if (ok) {
      const natural = cfg.executor_processes.every(n => exits.some(e => e.name === n && e.code === 0 && e.signal === null));
      t.executor_quiescent_us = nowUs();
      const views = await Promise.all(RECIPIENTS.map(x => ctl[x].request({ op: 'state' })));
      const view = views.every(v => v && v.ok === true) ? { journal_seq: { P: Number(views[0]!.journal_seq), Q: Number(views[1]!.journal_seq) }, states: { P: views[0]!.state as RecipientState, Q: views[1]!.state as RecipientState } } : null;
      steps.executor_quiescence = { status: 'natural', cgroup_populated: false, natural_exit: natural, killed: false, elapsed_ms: Math.round((t.executor_quiescent_us - t0) / 1000), recipient_view: view };
      if (!natural) failure = 'executor_exit_not_natural';
      t.t_r_start_us = nowUs();
      steps.recipient_quiescence = await recipientQuiescence();
      if (steps.recipient_quiescence.status === 'observed') t.recipient_quiescent_us = nowUs(); else failure = failure ?? 'recipient_not_quiescent_within_T_r';
      const f = await fence('final');
      t.final_fence_us = nowUs();
      steps.final_fence = { status: f ? 'present' : 'missing', fence_id: 'final' };
      steps.final_snapshots = f ? { status: 'taken', states: states(f) } : { status: 'failed', states: null };
      if (!f) failure = failure ?? 'final_fence_missing';
    } else {
      steps.executor_quiescence = { status: 'timeout_killed', cgroup_populated: populated(), natural_exit: false, killed: true, elapsed_ms: timing.T_q_ms, recipient_view: null };
      failure = 'executor_not_quiescent_within_T_q';
      await cleanup('executor_timeout');
      steps.executor_quiescence.killed = killed;
    }
  }
  // Late answers: every answer after the first recorded decision or after the timeout.
  for (const [id, rec] of tl) for (const a of answers.get(id) ?? []) if (a !== rec.answer) rec.late_answers.push(a);
  t.attempts = [...tl.values()];

  // Journals, read from the doubles' own files.
  const readJournal = (r: Recipient): Entry[] | null => {
    try {
      const text = readFileSync(cfg.journals[r], 'utf8');
      return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (e) { err('journal_unreadable', `${r}: ${String(e)}`); return null; }
  };
  const canary = (() => { try { return readFileSync(cfg.canary_journal, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { err('canary_journal_unreadable', String(e)); return []; } })();

  send({ type: 'case_done' });
  await waitFor(() => isolationAfter !== null, nowUs() + 60_000_000);
  const before = isolationBefore as unknown as Record<string, unknown>;
  const after = (isolationAfter ?? {}) as Record<string, unknown>;
  const probes = (before.probes ?? []) as RunRecord['isolation']['probes'];
  const allBlocked = probes.length > 0 && probes.every(p => p.results.length > 0 && p.results.every(x => x.blocked));
  const observation: Observation = {
    format: OBSERVATION_FORMAT, case_id: plan.case_id, source: 'local_doubles' as Observation['source'],
    timing: { T_w_ms: timing.T_w_ms, T_q_ms: timing.T_q_ms, T_r_ms: timing.T_r_ms },
    isolation: { canary_probe_blocked: allBlocked, canary_hits: canary.length, config_before_sha256: String(before.config_sha256), config_after_sha256: String(after.config_sha256 ?? '') },
    delay_element: plan.delay_element ? { attempt: plan.delay_element.attempt, delay_ms: plan.delay_element.delay_ms } : null,
    attempts,
    journals: { P: readJournal('P'), Q: readJournal('Q') },
    snapshots: { baseline, provisional },
    final_closure: { confirmed: failure === null, failure_reason: failure, steps },
    post_cleanup_collection: post,
  };
  const record: RunRecord = {
    format: RUN_RECORD_FORMAT, run_id: cfg.run_id, case_id: plan.case_id, guard: cfg.guard, timeline: t,
    guard_events: guardEvents, executor_processes: exits, protocol_errors: protocolErrors,
    isolation: {
      probes, config_before_sha256: String(before.config_sha256), config_after_sha256: (after.config_sha256 as string) ?? null,
      config_before: String(before.config_text), config_after: (after.config_text as string) ?? null,
      drop_counters_before: (before.drop_counters ?? {}) as Record<string, number>, drop_counters_after: (after.drop_counters ?? null) as Record<string, number> | null,
      canary_hits: canary, netem: (before.netem ?? []) as RunRecord['isolation']['netem'],
      channel: (before.channel ?? { journal_files: [], ctl_sockets: [] }) as RunRecord['isolation']['channel'],
    },
    errors,
  };
  if (!existsSync(cfg.out_dir)) mkdirSync(cfg.out_dir, { recursive: true });
  writeFileSync(join(cfg.out_dir, 'observation.json'), canonicalJson(observation) + '\n');
  writeFileSync(join(cfg.out_dir, 'run-record.json'), canonicalJson(record) + '\n');
  for (const r of RECIPIENTS) ctl[r].close();
  netem.close();
  process.exit(0);
}

if (require.main === module) void main();
