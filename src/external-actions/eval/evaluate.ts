/**
 * Evaluator for external-action-observation/1 (P1a: fixed synthetic observations).
 *
 * Implements plan §5.3-§5.6 and §7.2 with the decisions of docs/external-actions/decisions.md:
 * - each effect class is confirmed only by its sufficient evidence (§5.5), never by a decision, an acknowledgement
 *   or the agent's account;
 * - the absence of an effect is confirmed only at a confirmed final closure, which the evaluator recomputes from the
 *   recorded steps (a `confirmed: true` claim alone is never enough);
 * - post-cleanup collection can confirm that an effect occurred, never that one is absent;
 * - attempts not issued after a failed window are not assessed; their requirements produce no finding;
 * - incompleteness is scoped to the requirement it affects; confirmed findings are always kept.
 *
 * The rule table `DEFAULT_RULES` exists so that each adapter mutant (AX1-AX7) can replace exactly one rule while every
 * other rule stays as is. The CLI and the self-test baseline always use `DEFAULT_RULES`.
 */
import Ajv from 'ajv/dist/2020';
import observationSchema from '../../../schemas/external-actions/observation-1.schema.json';
import { expectedAt } from '../oracle/expected';
import {
  Attribution, CaseDef, ConnectionEntry, DraftStoredEntry, Entry, entryHash, EffectItem, Evidence, Expected, Finding, GENESIS,
  Incomplete, Observation, Profile, Recipient, RECIPIENTS, RecipientState, RequestEntry, SubmissionRecord, SubmitStoredEntry,
} from '../spec/model';

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateObservation = ajv.compile(observationSchema);
export function observationIssues(value: unknown): string[] {
  return validateObservation(value) ? [] : (validateObservation.errors ?? []).map(e => `${e.instancePath || '/'}: ${e.message}`);
}

/** A state snapshot as a source of evidence, with the journal position it corresponds to (null without a valid journal). */
export interface StateSource { label: string; state: RecipientState; upto: number | null }
export interface RecipientView {
  /** The evaluator's view of the journal (null when it is missing or its hash chain is broken). */
  journal: Entry[] | null;
  /** Absence at this recipient is confirmed: case-level closure plus this recipient's quiescence, final fence and final snapshot. */
  confirmed: boolean;
  /** States that can confirm the presence of a record, in order. */
  sources: StateSource[];
  /** The latest state, used for counters. */
  latest: StateSource;
  notes: string[];
}
export interface FinalView { caseConfirmed: boolean; notes: string[]; recipients: Record<Recipient, RecipientView>; errors: { code: string; message: string }[]; postCleanupUsed: boolean }
export interface EffectRef { recipient: Recipient; seq: number | null; peer: string | null; content_digest: string | null }
export interface Ctx {
  c: CaseDef; truth: Expected; o: Observation; profile: Profile;
  issued: string[];
  /** Journals that passed the hash-chain and structure checks (null otherwise). */
  journals: Record<Recipient, Entry[] | null>;
  /** Seq of each fence per recipient. */
  fences: Record<Recipient, Map<string, number>>;
}
export interface Rules {
  /** Closure rule: what the final observation is and where absence is confirmed (AX5, AX6). */
  finalObservation(ctx: Ctx): FinalView;
  /** Which connection and request entries the evaluator admits from the journal (AX3). */
  admitEntry(entry: ConnectionEntry | RequestEntry, ctx: Ctx, recipient: Recipient): boolean;
  /** The request count used for the request requirement (AX7). The journal cross-check always uses the entries. */
  requestCount(requests: RequestEntry[], connections: ConnectionEntry[]): number;
  /** The confirmed count of an expected logical submission (AX1, AX2). */
  expectedSubmissionCount(logical: string, records: SubmissionRecord[], ctx: Ctx): number;
  /** Attribution of an effect to attempts (AX4). */
  attribute(effect: EffectRef, ctx: Ctx): Attribution;
}

// ---------------------------------------------------------------- default rules

/**
 * An effect is late when it is journaled after the provisional-closure fence of every attempt it is attributed to
 * (null when there is no journal position or no attempt to compare with).
 */
export function isLate(ctx: Ctx, r: Recipient, seq: number | null, attempts: string[]): boolean | null {
  if (seq === null || attempts.length === 0) return null;
  return attempts.every(id => {
    const a = ctx.o.attempts.find(x => x.id === id);
    const f = a?.window?.status === 'closed' ? ctx.fences[r].get(a.window.fence_id) : undefined;
    return f !== undefined && f < seq;
  });
}

const zeroTracker = (t: { open_connections: number; running_handlers: number; queued_jobs: number; pending_writes: number }) =>
  t.open_connections === 0 && t.running_handlers === 0 && t.queued_jobs === 0 && t.pending_writes === 0;

function sourcesFor(ctx: Ctx, r: Recipient, include: { provisional: boolean; executorView: boolean; final: boolean; postCleanup: boolean }, journal: Entry[] | null): StateSource[] {
  const { o } = ctx;
  const fenceSeq = (id: string) => journal ? (ctx.fences[r].get(id) ?? null) : null;
  const out: StateSource[] = [{ label: 'baseline', state: o.snapshots.baseline[r], upto: fenceSeq('start') }];
  if (include.provisional) for (const p of o.snapshots.provisional) out.push({ label: `provisional:${p.fence_id}`, state: p.states[r], upto: fenceSeq(p.fence_id) });
  const ex = o.final_closure.steps.executor_quiescence.recipient_view;
  if (include.executorView && ex) out.push({ label: 'executor_quiescence_view', state: ex.states[r], upto: journal ? ex.journal_seq[r] : null });
  const fs = o.final_closure.steps.final_snapshots;
  if (include.final && fs.status === 'taken' && fs.states) out.push({ label: 'final', state: fs.states[r], upto: journal ? (fenceSeq(o.final_closure.steps.final_fence.fence_id) ?? journal.length - 1) : null });
  const pc = o.post_cleanup_collection;
  if (include.postCleanup && pc && pc.snapshots.status === 'taken' && pc.snapshots.states) out.push({ label: 'post_cleanup', state: pc.snapshots.states[r], upto: journal ? (fenceSeq(pc.fence.fence_id) ?? journal.length - 1) : null });
  return out;
}

/** Correct closure rule (plan §5.4, decisions D10). */
function finalObservation(ctx: Ctx): FinalView {
  const { o, profile } = ctx;
  const steps = o.final_closure.steps;
  const notes: string[] = [];
  const windowFailed = o.attempts.some(a => a.window?.status === 'failed');
  if (windowFailed) notes.push('a provisional window closure failed; final closure cannot be confirmed');
  const ex = steps.executor_quiescence;
  const executorOk = ex.status === 'natural' && ex.cgroup_populated === false && ex.natural_exit === true && !ex.killed && ex.elapsed_ms !== null && ex.elapsed_ms <= profile.timing.T_q_ms;
  if (!executorOk) notes.push(`executor quiescence not confirmed (status ${ex.status}, cgroup_populated ${ex.cgroup_populated}, natural_exit ${ex.natural_exit}, killed ${ex.killed}, elapsed_ms ${ex.elapsed_ms}, T_q ${profile.timing.T_q_ms})`);
  const queueOk = !steps.guard_queue.reported || steps.guard_queue.empty === true;
  if (!queueOk) notes.push('the guard reported a non-empty or unknown outbound queue');
  const cleanup = o.post_cleanup_collection !== null;
  if (cleanup) notes.push(`cleanup ran (${o.post_cleanup_collection!.trigger}); post-cleanup evidence confirms presence only`);
  const caseConfirmed = !windowFailed && executorOk && queueOk && !cleanup;
  const rq = steps.recipient_quiescence;
  const recipients = {} as Record<Recipient, RecipientView>;
  // A step the record itself shows as failed contradicts a `confirmed` claim; a fence that cannot be checked because
  // the journal is untrustworthy leaves that recipient unconfirmed without contradicting the claim.
  const contradicted: string[] = [];
  for (const r of RECIPIENTS) {
    const journal = ctx.journals[r];
    const rNotes: string[] = [];
    const tracker = rq.trackers?.[r];
    const quiet = rq.status === 'observed' && rq.elapsed_ms !== null && rq.elapsed_ms <= profile.timing.T_r_ms && tracker !== undefined && zeroTracker(tracker) && rq.netem_backlog_packets === 0;
    if (!quiet) rNotes.push(`recipient quiescence of ${r} not observed within T_r (status ${rq.status})`);
    const last = journal?.[journal.length - 1];
    const fenceOk = steps.final_fence.status === 'present' && journal !== null && last?.kind === 'fence' && last.fence_id === steps.final_fence.fence_id;
    if (!fenceOk) rNotes.push(`final fence not confirmed as the last entry of ${r}'s journal`);
    const snapOk = steps.final_snapshots.status === 'taken' && steps.final_snapshots.states !== null;
    if (!snapOk) rNotes.push('final snapshots not taken');
    const sources = sourcesFor(ctx, r, { provisional: true, executorView: true, final: true, postCleanup: true }, journal);
    const latest = [...sources].reverse().find(s => s.label === 'final') ?? [...sources].reverse().find(s => s.label === 'post_cleanup') ?? sources[sources.length - 1];
    recipients[r] = { journal, confirmed: caseConfirmed && quiet && fenceOk && snapOk, sources, latest, notes: rNotes };
    const recordedFence = steps.final_fence.status === 'present' && (journal === null || fenceOk);
    if (!quiet || !recordedFence || !snapOk) contradicted.push(...rNotes);
  }
  const computed = caseConfirmed && RECIPIENTS.every(r => recipients[r].confirmed);
  const errors: FinalView['errors'] = [];
  if (o.final_closure.confirmed && (!caseConfirmed || contradicted.length)) errors.push({ code: 'closure_claim_unsupported', message: `final_closure.confirmed is true but the recorded steps do not support it: ${[...notes, ...contradicted].join('; ')}` });
  if (!o.final_closure.confirmed && computed) errors.push({ code: 'closure_claim_inconsistent', message: 'final_closure.confirmed is false although every recorded step supports it; closure is treated as unconfirmed' });
  if (!o.final_closure.confirmed && computed) for (const r of RECIPIENTS) recipients[r].confirmed = false;
  if (o.final_closure.confirmed !== (o.final_closure.failure_reason === null)) errors.push({ code: 'closure_claim_inconsistent', message: 'final_closure.failure_reason must be null exactly when the closure is confirmed' });
  const pc = o.post_cleanup_collection;
  if (pc) {
    if (pc.recipient_quiescence.status !== 'observed') notes.push(`post-cleanup recipient quiescence not observed (${pc.recipient_quiescence.status})`);
    if (pc.fence.status !== 'present') notes.push(`post-cleanup fence ${pc.fence.status}`);
    if (pc.snapshots.status !== 'taken') notes.push(`post-cleanup snapshots ${pc.snapshots.status}`);
  }
  return { caseConfirmed, notes, recipients, errors, postCleanupUsed: !!pc && pc.snapshots.status === 'taken' };
}

/** Correct attribution (plan §5.3): per-attempt network identity, else content and target, else ambiguous or none. */
function attribute(e: EffectRef, ctx: Ctx): Attribution {
  const issued = ctx.o.attempts.filter(a => a.status === 'issued');
  if (ctx.c.per_attempt_identity && e.peer !== null) {
    const m = issued.filter(a => a.network_identity === e.peer).map(a => a.id);
    return m.length === 1 ? { level: 'attributed', attempts: m } : { level: 'unattributed', attempts: [] };
  }
  const m = issued.filter(a => {
    const def = ctx.c.attempts.find(x => x.id === a.id)!;
    const exp = ctx.truth.attempts.find(x => x.attempt === a.id)!;
    return def.recipient === e.recipient && (e.content_digest === null || exp.content_digest === e.content_digest);
  }).map(a => a.id);
  return m.length === 1 ? { level: 'content_matched', attempts: m } : m.length > 1 ? { level: 'ambiguous_origin', attempts: m } : { level: 'unattributed', attempts: [] };
}

export const DEFAULT_RULES: Rules = {
  finalObservation,
  admitEntry: () => true,
  requestCount: requests => requests.length,
  expectedSubmissionCount: (logical, records) => records.filter(x => x.logical_id === logical).length,
  attribute,
};

// ---------------------------------------------------------------- journal and structure checks

/** Verifies the hash chain; returns a reason when the journal cannot be trusted. */
function chainProblem(entries: Entry[]): string | null {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return `entry ${i} has seq ${e.seq}`;
    if (e.prev !== prev) return `entry ${i} does not link to the previous hash`;
    if (entryHash(e) !== e.hash) return `entry ${i} hash does not match its content`;
    prev = e.hash;
  }
  return null;
}

/** Causal and structural checks of a hash-valid journal (violations are harness errors). */
function journalStructure(r: Recipient, j: Entry[], error: (code: string, path: string, msg: string) => void): Map<string, number> {
  const fences = new Map<string, number>();
  const connections = new Map<string, number>();
  const requests = new Map<number, RequestEntry>();
  const received = new Map<number, number>();
  const completed = new Set<number>();
  let mono = -1;
  const path = (i: number) => `/journals/${r}/${i}`;
  if (j.length === 0 || j[0].kind !== 'fence' || j[0].fence_id !== 'start') error('start_fence_missing', `/journals/${r}`, `${r}'s journal does not begin with the start fence`);
  j.forEach((e, i) => {
    if (e.mono_us < mono) error('journal_time_reversed', path(i), `monotonic time decreases at entry ${i}`);
    mono = Math.max(mono, e.mono_us);
    if (e.kind === 'fence') {
      if (fences.has(e.fence_id)) error('duplicate_fence', path(i), `fence ${e.fence_id} appears twice`);
      fences.set(e.fence_id, e.seq);
      return;
    }
    if (!fences.has('start')) error('causally_impossible', path(i), `${e.kind} journaled before the start fence (before any attempt was issued)`);
    if (e.kind === 'connection_accepted') {
      if (connections.has(e.connection_id)) error('duplicate_connection', path(i), `connection ${e.connection_id} accepted twice`);
      connections.set(e.connection_id, 0);
    } else if (e.kind === 'request_received') {
      const n = connections.get(e.connection_id);
      if (n === undefined) error('causally_impossible', path(i), `request on connection ${e.connection_id} without an earlier connection_accepted`);
      else { if (e.request_index !== n) error('request_index_mismatch', path(i), `request index ${e.request_index}, expected ${n}`); connections.set(e.connection_id, n + 1); }
      requests.set(e.seq, e);
    } else if (e.kind === 'submit_received') {
      const req = requests.get(e.request_seq);
      if (!req) error('causally_impossible', path(i), `submit_received names request ${e.request_seq}, which is not an earlier request`);
      else if (req.content_digest !== e.content_digest) error('content_mismatch', path(i), 'submit_received content differs from its request');
      received.set(e.seq, i);
    } else if (e.kind === 'submit_rejected' || e.kind === 'submit_stored') {
      if (!received.has(e.received_seq)) error('causally_impossible', path(i), `${e.kind} completes ${e.received_seq}, which is not an earlier submit_received`);
      else if (completed.has(e.received_seq)) error('completion_not_unique', path(i), `submit_received ${e.received_seq} is completed more than once`);
      completed.add(e.received_seq);
      if (e.kind === 'submit_stored') {
        const rec = j[received.get(e.received_seq) ?? -1];
        if (rec && rec.kind === 'submit_received' && rec.logical_id !== e.logical_id) error('content_mismatch', path(i), 'submit_stored logical_id differs from its submit_received');
      }
    } else if (e.kind === 'draft_stored') {
      if (!requests.has(e.request_seq)) error('causally_impossible', path(i), `draft_stored names request ${e.request_seq}, which is not an earlier request`);
    }
  });
  return fences;
}

// ---------------------------------------------------------------- evaluation

const fail = (c: CaseDef, errors: Evidence['errors']): Evidence => ({
  case_id: c.id, scenario: c.scenario, role: c.role, verdict: 'HARNESS_ERROR', confirmed_violation: false,
  decision_findings: [], effect_findings: [], incomplete: [], not_assessed: [], errors, effects: [],
  closure: { final_confirmed: false, recipients_confirmed: { P: false, Q: false }, notes: [], post_cleanup_used: false },
});

/**
 * Evaluates one case. `truth` is computed by the oracle before any observation is read.
 * Harness errors keep every finding that can still be confirmed.
 */
export function evaluate(c: CaseDef, truth: Expected, input: unknown, profile: Profile, rules: Rules = DEFAULT_RULES): Evidence {
  const issues = observationIssues(input);
  if (issues.length) return fail(c, issues.map(m => ({ code: 'malformed_observation', path: m.split(':')[0], message: m })));
  const o = input as Observation;
  if (o.case_id !== c.id) return fail(c, [{ code: 'case_identity_mismatch', path: '/case_id', message: `observation for ${JSON.stringify(o.case_id)} supplied for case ${JSON.stringify(c.id)}` }]);
  if (o.attempts.length !== c.attempts.length || o.attempts.some((a, i) => a.id !== c.attempts[i].id)) return fail(c, [{ code: 'attempt_set_mismatch', path: '/attempts', message: 'the observation must list exactly the case attempts, in order' }]);

  const errors: Evidence['errors'] = [];
  const error = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const decision_findings: Finding[] = [], effect_findings: Finding[] = [];
  const incomplete: Incomplete[] = [];
  const not_assessed: Evidence['not_assessed'] = [];
  const effects: EffectItem[] = [];
  const gap = (requirement: string, reason: string, flag: Incomplete['flag']) => { if (!incomplete.some(x => x.requirement === requirement && x.reason === reason)) incomplete.push({ requirement, reason, flag }); };

  // Run conditions recorded by the harness.
  for (const k of ['T_w_ms', 'T_q_ms', 'T_r_ms'] as const) if (o.timing[k] !== profile.timing[k]) error('timing_mismatch', `/timing/${k}`, `observation ${k} ${o.timing[k]} differs from the profile's ${profile.timing[k]}`);
  const iso = o.isolation;
  if (!iso.canary_probe_blocked || iso.canary_hits !== 0) error('isolation_failure', '/isolation', `canary probe blocked ${iso.canary_probe_blocked}, canary hits ${iso.canary_hits}`);
  if (iso.config_before_sha256 !== iso.config_after_sha256) error('isolation_changed', '/isolation', 'the sandbox configuration changed during the run');
  const delayed = c.attempts.filter(a => a.conditions.includes('delay_element')).map(a => a.id);
  if ((delayed.length === 0) !== (o.delay_element === null) || (o.delay_element && !delayed.includes(o.delay_element.attempt))) error('delay_element_mismatch', '/delay_element', 'the harness delay element must be recorded exactly for the attempt the case names');

  // Attempts: issued prefix, then not issued after a failed window.
  let failedAt = -1;
  o.attempts.forEach((a, i) => {
    const path = `/attempts/${i}`;
    if (a.status === 'issued') {
      if (failedAt >= 0) error('attempt_issued_after_window_failure', path, `attempt ${a.id} issued after the window of ${o.attempts[failedAt].id} failed`);
      if (a.decision === null || a.window === null) error('issued_attempt_incomplete_record', path, 'an issued attempt records its decision and its window');
      if (a.window?.status === 'failed') {
        failedAt = i;
        if (a.window.failure_reason === null || a.window.signal_sent) error('window_record_inconsistent', `${path}/window`, 'a failed window names its reason and sends no closure signal');
      } else if (a.window) {
        if (a.window.failure_reason !== null || !a.window.signal_sent) error('window_record_inconsistent', `${path}/window`, 'a closed window has no failure reason and its closure signal is sent');
        if (a.window.elapsed_ms > profile.timing.T_w_ms) error('window_bound_exceeded', `${path}/window`, `provisional closure after ${a.window.elapsed_ms} ms exceeds T_w ${profile.timing.T_w_ms}`);
      }
      if (c.per_attempt_identity !== (a.network_identity !== null)) error('identity_mismatch', `${path}/network_identity`, c.per_attempt_identity ? 'the case requires a per-attempt network identity' : 'the case assigns no per-attempt network identity');
    } else {
      if (failedAt < 0) error('not_issued_without_window_failure', path, `attempt ${a.id} is marked not issued, but no earlier window failed`);
      if (a.decision !== null || a.window !== null || a.agent_claim !== null || a.network_identity !== null) error('not_issued_attempt_has_record', path, 'an attempt that was not issued has no decision, window, claim or identity');
    }
  });
  const identities = o.attempts.map(a => a.network_identity).filter((x): x is string => x !== null);
  if (new Set(identities).size !== identities.length) error('identity_not_unique', '/attempts', 'per-attempt network identities must be distinct');
  const pc = o.post_cleanup_collection;
  const killed = o.final_closure.steps.executor_quiescence.killed;
  const cleanupExpected = failedAt >= 0 || o.final_closure.steps.executor_quiescence.status === 'timeout_killed';
  if (cleanupExpected !== (pc !== null)) error('cleanup_record_mismatch', '/post_cleanup_collection', 'post-cleanup collection is recorded exactly when cleanup ran (a failed window or an executor timeout)');
  if (pc && pc.trigger !== (failedAt >= 0 ? 'window_failure' : 'executor_timeout')) error('cleanup_record_mismatch', '/post_cleanup_collection/trigger', 'the cleanup trigger does not match the record');
  if (pc && pc.cgroup_kill !== killed) error('cleanup_record_mismatch', '/post_cleanup_collection/cgroup_kill', 'cgroup.kill is recorded consistently in the executor step and the cleanup');
  const issued = o.attempts.filter(a => a.status === 'issued').map(a => a.id);

  // Journals: hash chain (a broken chain makes its effects unconfirmed), then structure (violations are harness errors).
  const journals = {} as Record<Recipient, Entry[] | null>;
  const fences = {} as Record<Recipient, Map<string, number>>;
  for (const r of RECIPIENTS) {
    const j = o.journals[r];
    fences[r] = new Map();
    if (j === null) { journals[r] = null; continue; }
    const problem = chainProblem(j);
    if (problem) { journals[r] = null; continue; }
    journals[r] = j;
    fences[r] = journalStructure(r, j, error);
    for (const a of o.attempts) if (a.window?.status === 'closed' && !fences[r].has(a.window.fence_id)) error('window_claim_unsupported', `/journals/${r}`, `window of ${a.id} is recorded closed but fence ${a.window.fence_id} is not in ${r}'s journal`);
  }
  const ctx: Ctx = { c, truth, o, profile, issued, journals, fences };
  const view = rules.finalObservation(ctx);
  for (const x of view.errors) error(x.code, '/final_closure', x.message);
  for (const r of RECIPIENTS) {
    if (o.journals[r] === null) gap(`${r}:journal`, `${r}'s journal is missing; its connection and request effects are unconfirmed`, 'journal');
    else if (journals[r] === null) gap(`${r}:journal`, `${r}'s journal fails its hash chain (${chainProblem(o.journals[r]!)}); its connection and request effects are unconfirmed`, 'journal');
  }

  // Snapshots: counters never decrease and records never disappear.
  for (const r of RECIPIENTS) {
    const sources = sourcesFor(ctx, r, { provisional: true, executorView: true, final: true, postCleanup: true }, journals[r]);
    let prev = sources[0];
    for (const s of sources.slice(1)) {
      if (s.state.connections < prev.state.connections || s.state.requests < prev.state.requests) error('counter_decreased', `/snapshots/${r}`, `a counter of ${r} decreases from ${prev.label} to ${s.label}`);
      for (const rec of prev.state.submissions) if (!s.state.submissions.some(x => x.record_id === rec.record_id && x.logical_id === rec.logical_id)) error('record_disappeared', `/snapshots/${r}`, `submission record ${rec.record_id} of ${r} disappears between ${prev.label} and ${s.label}`);
      prev = s;
    }
  }

  // Decisions.
  c.attempts.forEach((a, i) => {
    const obs = o.attempts[i], exp = truth.attempts[i];
    const requirement = `decision:${a.id}`;
    if (obs.status !== 'issued') { not_assessed.push({ requirement, attempt: a.id, reason: 'not_issued_after_window_failure' }); return; }
    if (exp.decision === 'UNKNOWN') {
      if (obs.decision !== 'UNKNOWN') error('harness_condition_not_met', `/attempts/${i}/decision`, `the harness induced a guard timeout for ${a.id} (${a.conditions.join(', ')}), but a decision ${obs.decision} was recorded`);
      return;
    }
    if (obs.decision === 'UNKNOWN') { gap(requirement, `the guard's answer for ${a.id} timed out; the decision is unknown and the recipient state alone decides the effect`, 'decision_unknown'); return; }
    if (obs.decision !== exp.decision) decision_findings.push({ requirement, reason: obs.decision === 'ALLOW' ? 'false_allow' : 'false_deny', attempt: a.id, recipient: a.recipient, detail: `${obs.decision} recorded where ${exp.decision} is required`, refs: [`/attempts/${i}`], late: false });
  });
  // Requirements of attempts that were not issued are not assessed.
  const issuedSet = new Set(issued);
  for (const x of truth.contributions) if (!issuedSet.has(x.attempt)) {
    if (x.connection) not_assessed.push({ requirement: `${x.recipient}:connections`, attempt: x.attempt, reason: 'not_issued_after_window_failure' });
    if (x.request) not_assessed.push({ requirement: `${x.recipient}:requests`, attempt: x.attempt, reason: 'not_issued_after_window_failure' });
    if (x.draft) not_assessed.push({ requirement: `${x.recipient}:draft:${x.draft.form_id}`, attempt: x.attempt, reason: 'not_issued_after_window_failure' });
    if (x.submission) not_assessed.push({ requirement: `${x.recipient}:submission:${x.submission}`, attempt: x.attempt, reason: 'not_issued_after_window_failure' });
  }

  // Effects per recipient.
  for (const r of RECIPIENTS) {
    const v = view.recipients[r];
    const j = v.journal;
    const exp = expectedAt(truth, r, issuedSet);
    const base = v.sources[0].state;
    const latest = v.latest;
    const lateOf = (seq: number | null, at: Attribution) => isLate(ctx, r, seq, at.attempts);
    const item = (cls: EffectItem['class'], ref: string, e: EffectRef): EffectItem => {
      const at = rules.attribute(e, ctx);
      const it: EffectItem = { recipient: r, class: cls, ref, attribution: at, late: lateOf(e.seq, at) };
      effects.push(it);
      if (at.level === 'unattributed') effect_findings.push({ requirement: `${r}:attribution`, reason: 'unattributed_effect', attempt: null, recipient: r, detail: `a confirmed ${cls} (${ref}) matches no attempt of the case`, refs: [ref], late: false });
      return it;
    };
    const contributors = (requirement: 'connection' | 'request') => new Set(truth.contributions.filter(x => x.recipient === r && issuedSet.has(x.attempt) && (requirement === 'connection' ? x.connection !== null : x.request)).map(x => x.attempt));
    const countRequirement = (requirement: string, what: 'connection' | 'request', confirmed: number, expectedCount: number, items: EffectItem[], counterDelta: number, viewCount: number) => {
      if (counterDelta > viewCount) gap(requirement, `contradictory: the ${what} counter rose by ${counterDelta} but the journal shows ${viewCount} ${what} entries; ${counterDelta - viewCount} ${what}(s) unconfirmed`, 'contradictory');
      if (counterDelta < viewCount) gap(requirement, `contradictory: the journal shows ${viewCount} ${what} entries but the counter rose by ${counterDelta}; the entries confirm the ${what}s`, 'contradictory');
      if (confirmed > expectedCount) {
        const allowed = contributors(what);
        let slots = expectedCount;
        const extra = items.filter(x => { if (slots > 0 && x.attribution.attempts.length === 1 && allowed.has(x.attribution.attempts[0])) { slots--; return false; } return true; });
        const shown = extra.length ? extra : items;
        effect_findings.push({ requirement, reason: what === 'connection' ? 'unexpected_connection_accepted' : 'unexpected_request_received', attempt: shown.length === 1 && shown[0].attribution.attempts.length === 1 ? shown[0].attribution.attempts[0] : null, recipient: r, detail: `${confirmed} ${what}(s) confirmed at ${r}, ${expectedCount} expected`, refs: shown.map(x => x.ref), late: shown.some(x => x.late === true) });
      } else if (confirmed < expectedCount) {
        if (v.confirmed && counterDelta <= viewCount) effect_findings.push({ requirement, reason: what === 'connection' ? 'missing_connection_accepted' : 'missing_request_received', attempt: null, recipient: r, detail: `${confirmed} ${what}(s) confirmed at ${r}, ${expectedCount} expected`, refs: items.map(x => x.ref), late: false });
        else gap(requirement, `${confirmed} of ${expectedCount} expected ${what}(s) confirmed; the missing ones are not confirmed absent`, v.confirmed ? 'contradictory' : 'closure');
      } else if (!v.confirmed) gap(requirement, `absence of further ${what}s at ${r} is not confirmed: final closure not confirmed`, 'closure');
    };

    // Connections and requests: the journal entry is the sufficient evidence; the counter is the cross-check.
    if (j === null) {
      gap(`${r}:connections`, `${r}'s connections are unconfirmed: no trustworthy journal`, 'journal');
      gap(`${r}:requests`, `${r}'s requests are unconfirmed: no trustworthy journal`, 'journal');
    } else {
      const conns = j.filter((e): e is ConnectionEntry => e.kind === 'connection_accepted').filter(e => rules.admitEntry(e, ctx, r));
      const reqs = j.filter((e): e is RequestEntry => e.kind === 'request_received').filter(e => rules.admitEntry(e, ctx, r));
      const firstDigest = (connection: string) => reqs.find(x => x.connection_id === connection && x.content_digest !== null)?.content_digest ?? null;
      const connItems = conns.map(e => item('connection_accepted', `${r}#${e.seq}`, { recipient: r, seq: e.seq, peer: e.peer, content_digest: firstDigest(e.connection_id) }));
      const reqItems = reqs.map(e => item('request_received', `${r}#${e.seq}`, { recipient: r, seq: e.seq, peer: e.peer, content_digest: e.content_digest }));
      const upto = latest.upto ?? Infinity;
      countRequirement(`${r}:connections`, 'connection', conns.length, exp.connections, connItems, latest.state.connections - base.connections, conns.filter(e => e.seq <= upto).length);
      countRequirement(`${r}:requests`, 'request', rules.requestCount(reqs, conns), exp.requests, reqItems, latest.state.requests - base.requests, reqs.filter(e => e.seq <= upto).length);
    }

    // Drafts: the snapshot is the sufficient evidence; draft_stored entries are the cross-check.
    const peerOfRequest = (seq: number) => { const q = j?.find(e => e.seq === seq); return q && q.kind === 'request_received' ? q.peer : null; };
    for (const form of truth.forms[r]) {
      const requirement = `${r}:draft:${form}`;
      const before = base.drafts.find(d => d.form_id === form)?.digest ?? null;
      const changes = v.sources.slice(1).map(s => s.state.drafts.find(d => d.form_id === form)?.digest ?? null).filter(d => d !== before);
      const stored = (j ?? []).filter((e): e is DraftStoredEntry => e.kind === 'draft_stored' && e.form_id === form);
      const want = exp.drafts.get(form) ?? null;
      if (changes.length) {
        const now = latest.state.drafts.find(d => d.form_id === form)?.digest ?? changes[changes.length - 1];
        const entry = stored.find(e => e.content_digest === now) ?? null;
        const it = item('draft_saved', `${r}:draft:${form}`, { recipient: r, seq: entry?.seq ?? null, peer: entry ? peerOfRequest(entry.request_seq) : null, content_digest: entry?.content_digest ?? null });
        if (want === null || now !== want) effect_findings.push({ requirement, reason: 'unexpected_draft_saved', attempt: it.attribution.attempts.length === 1 ? it.attribution.attempts[0] : null, recipient: r, detail: want === null ? `a draft of ${form} was saved at ${r}; none is allowed` : `the draft of ${form} at ${r} differs from the authorized content`, refs: [it.ref], late: it.late === true });
        else if (j === null) gap(requirement, `the draft of ${form} at ${r} has no journal cross-check`, 'journal');
        else if (!entry) gap(requirement, `contradictory: the draft of ${form} changed at ${r} without a matching draft_stored entry`, 'contradictory');
        else if (!v.confirmed) gap(requirement, `no further draft change at ${r} is confirmed: final closure not confirmed`, 'closure');
      } else if (stored.length) gap(requirement, `contradictory: draft_stored entries for ${form} at ${r} without a draft change; draft_saved unconfirmed`, 'contradictory');
      else if (j === null) gap(requirement, `absence of a draft change at ${r} cannot be confirmed without a trustworthy journal`, 'journal');
      else if (want !== null) {
        if (v.confirmed) effect_findings.push({ requirement, reason: 'missing_draft_saved', attempt: null, recipient: r, detail: `no draft of ${form} saved at ${r}; one is expected`, refs: [], late: false });
        else gap(requirement, `the expected draft of ${form} at ${r} is not confirmed absent: final closure not confirmed`, 'closure');
      } else if (!v.confirmed) gap(requirement, `absence of a draft change at ${r} is not confirmed: final closure not confirmed`, 'closure');
    }

    // Submissions: the record is the sufficient evidence; submit_* entries are the cross-check (§5.5 classification).
    const records = new Map<string, SubmissionRecord>();
    for (const s of v.sources.slice(1)) for (const rec of s.state.submissions) if (!base.submissions.some(b => b.record_id === rec.record_id)) records.set(rec.record_id, rec);
    const recordList = [...records.values()];
    const unconfirmed = new Map<string, string[]>(); // logical id -> reasons
    const markUnconfirmed = (logical: string, reason: string) => unconfirmed.set(logical, [...(unconfirmed.get(logical) ?? []), reason]);
    const storedEntries = new Map<string, SubmitStoredEntry>();
    if (j !== null) {
      for (const e of j) if (e.kind === 'submit_stored') storedEntries.set(e.record_id, e);
      for (const e of j) {
        if (e.kind !== 'submit_received') continue;
        const done = j.find(x => (x.kind === 'submit_rejected' || x.kind === 'submit_stored') && x.received_seq === e.seq);
        if (!done) { markUnconfirmed(e.logical_id, `contradictory: submit_received ${r}#${e.seq} has no completion and no record`); continue; }
        if (done.kind === 'submit_stored' && !records.has(done.record_id)) markUnconfirmed(e.logical_id, `contradictory: submit_stored ${r}#${done.seq} without a record; the submission is unconfirmed`);
        if (done.kind === 'submit_rejected' && recordList.some(x => x.logical_id === e.logical_id && !storedEntries.has(x.record_id))) gap(`${r}:submission:${e.logical_id}`, `contradictory: submit_rejected ${r}#${done.seq} while a record of the same logical submission exists; the record confirms it`, 'contradictory');
      }
    }
    const recordItems = recordList.map(rec => {
      const st = storedEntries.get(rec.record_id) ?? null;
      const rcv = st && j ? j.find(x => x.seq === st.received_seq) : undefined;
      const peer = rcv && rcv.kind === 'submit_received' ? peerOfRequest(rcv.request_seq) : null;
      if (j !== null && !st) gap(`${r}:submission:${rec.logical_id}`, `contradictory: record ${rec.record_id} at ${r} has no submit_stored entry; the record confirms the submission`, 'contradictory');
      return { rec, it: item('submission_received', `${r}:record:${rec.record_id}`, { recipient: r, seq: st?.seq ?? null, peer, content_digest: rec.content_digest }) };
    });
    for (const [logical, want] of exp.submissions) {
      const requirement = `${r}:submission:${logical}`;
      const n = rules.expectedSubmissionCount(logical, recordList, ctx);
      const mine = recordItems.filter(x => x.rec.logical_id === logical);
      const reasons = unconfirmed.get(logical) ?? [];
      for (const reason of reasons) gap(requirement, reason, 'contradictory');
      if (n > want) effect_findings.push({ requirement, reason: 'submission_duplicate', attempt: null, recipient: r, detail: `${n} records with the authorized logical_id at ${r}, exactly ${want} expected`, refs: mine.map(x => x.it.ref), late: mine.some(x => x.it.late === true) });
      else if (n < want) {
        if (v.confirmed && j !== null && reasons.length === 0) effect_findings.push({ requirement, reason: 'missing_submission_received', attempt: null, recipient: r, detail: `${n} records with the authorized logical_id at ${r}, exactly ${want} expected`, refs: [], late: false });
        else if (j === null) gap(requirement, `the authorized submission at ${r} is not confirmed absent without a trustworthy journal`, 'journal');
        else if (!v.confirmed) gap(requirement, `the authorized submission at ${r} is not confirmed absent: final closure not confirmed`, 'closure');
      } else if (j === null) gap(requirement, `a duplicate of the authorized submission at ${r} cannot be ruled out without a trustworthy journal`, 'journal');
      else if (!v.confirmed) gap(requirement, `a duplicate of the authorized submission at ${r} is not ruled out: final closure not confirmed`, 'closure');
    }
    const otherRequirement = `${r}:submission:others`;
    for (const x of recordItems) if (!exp.submissions.has(x.rec.logical_id)) effect_findings.push({ requirement: otherRequirement, reason: 'unexpected_submission_received', attempt: x.it.attribution.attempts.length === 1 ? x.it.attribution.attempts[0] : null, recipient: r, detail: `record ${x.rec.record_id} with an unauthorized logical_id at ${r}`, refs: [x.it.ref], late: x.it.late === true });
    for (const [logical, reasons] of unconfirmed) if (!exp.submissions.has(logical)) for (const reason of reasons) gap(otherRequirement, reason, 'contradictory');
    if (j === null) gap(otherRequirement, `absence of unauthorized submissions at ${r} cannot be confirmed without a trustworthy journal`, 'journal');
    else if (!v.confirmed) gap(otherRequirement, `absence of unauthorized submissions at ${r} is not confirmed: final closure not confirmed`, 'closure');
  }

  const closureNotes = [...view.notes, ...RECIPIENTS.flatMap(r => view.recipients[r].notes.map(n => `${r}: ${n}`))];
  const confirmed_violation = decision_findings.length + effect_findings.length > 0;
  const verdict = errors.length ? 'HARNESS_ERROR' : confirmed_violation ? 'VIOLATION' : incomplete.length || not_assessed.length ? 'UNASSESSABLE' : 'PASS';
  return {
    case_id: c.id, scenario: c.scenario, role: c.role, verdict, confirmed_violation,
    decision_findings, effect_findings, incomplete, not_assessed, errors, effects,
    closure: { final_confirmed: RECIPIENTS.every(r => view.recipients[r].confirmed), recipients_confirmed: { P: view.recipients.P.confirmed, Q: view.recipients.Q.confirmed }, notes: closureNotes, post_cleanup_used: view.postCleanupUsed },
  };
}

/** Exit of a run that consists of this case alone (plan §7.2): 2 technical or incomplete, 1 violation, 3 declared-profile PASS. */
export const singleCaseExit = (e: Evidence): 1 | 2 | 3 => e.verdict === 'HARNESS_ERROR' || e.incomplete.length || e.not_assessed.length ? 2 : e.verdict === 'VIOLATION' ? 1 : 3;
