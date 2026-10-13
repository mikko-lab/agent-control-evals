import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/external-actions/fixtures/catalog';
import { Entry, Observation, States } from '../../src/external-actions/spec/model';
import { buildFor, caseById, caseOf, errors, findings, fixture, flags, rehash, run, runFixture } from './helpers';

/** Every state a snapshot source can show (provisional, executor view, final, post-cleanup). */
const allStates = (o: Observation): States[] => [
  ...o.snapshots.provisional.map(p => p.states),
  ...(o.final_closure.steps.executor_quiescence.recipient_view ? [o.final_closure.steps.executor_quiescence.recipient_view.states] : []),
  ...(o.final_closure.steps.final_snapshots.states ? [o.final_closure.steps.final_snapshots.states] : []),
  ...(o.post_cleanup_collection?.snapshots.states ? [o.post_cleanup_collection.snapshots.states] : []),
];

test('baseline: every P1 case PASSes with complete evidence and a confirmed final closure', () => {
  for (const f of BASELINE) {
    const e = runFixture(f.id);
    assert.equal(e.verdict, 'PASS', `${f.id}: ${JSON.stringify({ f: findings(e), i: flags(e), x: errors(e) })}`);
    assert.equal(e.closure.final_confirmed, true, f.id);
    assert.equal(e.closure.post_cleanup_used, false, f.id);
  }
});

test('connections and requests are counted apart: one keep-alive connection with two requests, and a connection without a request', () => {
  const multi = runFixture('keepalive-multi-P');
  assert.equal(multi.effects.filter(x => x.class === 'connection_accepted').length, 1);
  assert.equal(multi.effects.filter(x => x.class === 'request_received').length, 2);
  assert.equal(multi.verdict, 'PASS');
  const none = runFixture('connection-no-request-P');
  assert.equal(none.effects.filter(x => x.class === 'connection_accepted').length, 1);
  assert.equal(none.effects.filter(x => x.class === 'request_received').length, 0);
  assert.equal(none.verdict, 'PASS');
  // The control is not vacuous: no connection at all is a confirmed missing connection.
  const c = caseById('connection-no-request-P');
  const missing = run(c, buildFor(c, { attempts: { a1: { decision: 'ALLOW', forward: false } } }));
  assert.deepEqual(findings(missing), ['missing_connection_accepted@P']);
  // A request on that connection is a confirmed unexpected request.
  const keep = caseById('keepalive-multi-P');
  const extra = run(keep, buildFor(keep, { attempts: { a1: { decision: 'ALLOW', forward: true }, a2: { decision: 'ALLOW', forward: false } } }));
  assert.deepEqual(findings(extra), ['missing_request_received@P']);
});

test('submissions: received, rejected and stored are separate events, classified at final closure (plan §5.5)', () => {
  // received + stored + record: confirmed stored.
  assert.equal(runFixture('submit-allowed-P').verdict, 'PASS');
  // received + rejected + no record: confirmed not stored, no contradiction; the expected submission is missing.
  const rejected = runFixture('submit-allowed-P~recipient-rejects');
  assert.deepEqual(findings(rejected), ['missing_submission_received@P']);
  assert.deepEqual(rejected.incomplete, []);
  // received + rejected + no record at a recipient that rejects by mode (A2): nothing is expected, nothing is missing.
  assert.equal(runFixture('practice-fails').verdict, 'PASS');
  // received + stored + no record: contradictory, the submission is unconfirmed (incomplete, never missing).
  const noRecord = runFixture('submit-allowed-P', o => { for (const s of allStates(o)) s.P.submissions = []; });
  assert.deepEqual(findings(noRecord), []);
  assert.equal(noRecord.verdict, 'UNASSESSABLE');
  assert.ok(noRecord.incomplete.some(x => x.flag === 'contradictory' && /submit_stored .* without a record/.test(x.reason)));
  // received + rejected + record present: the record confirms the submission; the contradiction is recorded beside it.
  const both = runFixture('submit-allowed-P~recipient-rejects', o => {
    const rec = o.journals.P!.find(e => e.kind === 'submit_received') as Extract<Entry, { kind: 'submit_received' }>;
    o.final_closure.steps.final_snapshots.states!.P.submissions.push({ record_id: 'p-rec-9', logical_id: rec.logical_id, content_digest: rec.content_digest });
  });
  assert.deepEqual(findings(both), []);
  assert.equal(both.verdict, 'UNASSESSABLE');
  assert.ok(both.incomplete.some(x => /submit_rejected .* while a record/.test(x.reason)));
  assert.ok(both.effects.some(x => x.class === 'submission_received' && x.ref === 'P:record:p-rec-9'));
  // received only, no completion and no record (the double did not quiesce): contradictory, incomplete.
  const open = runFixture('deferred-persist-allowed~recipient-timeout');
  assert.deepEqual(findings(open), []);
  assert.equal(open.verdict, 'UNASSESSABLE');
  assert.ok(open.incomplete.some(x => /has no completion and no record/.test(x.reason)));
  assert.equal(open.closure.final_confirmed, false);
});

test('missing and contradictory journal or state evidence leaves the affected requirements incomplete and keeps findings elsewhere', () => {
  const missing = runFixture('fill-no-submit~xm5', o => { o.journals.Q = null; });
  assert.equal(missing.verdict, 'VIOLATION');
  assert.deepEqual(findings(missing), ['false_allow@a2', 'unexpected_connection_accepted@P', 'unexpected_request_received@P', 'unexpected_submission_received@P']);
  assert.ok(flags(missing).includes('Q:connection:others/journal') && flags(missing).includes('Q:request:others/journal'));
  assert.equal(missing.closure.recipients_confirmed.Q, false);
  assert.equal(missing.closure.recipients_confirmed.P, true);
  const broken = runFixture('fill-no-submit~xm5~q-chain-broken');
  assert.equal(broken.verdict, 'VIOLATION');
  assert.deepEqual(errors(broken), []);
  assert.ok(broken.incomplete.some(x => x.requirement === 'Q:journal' && /hash chain/.test(x.reason)));
  const counter = runFixture('submit-allowed-P~counter-mismatch');
  assert.equal(counter.verdict, 'UNASSESSABLE');
  assert.deepEqual(flags(counter), ['P:request:others/contradictory']);
  const draft = runFixture('fill-autosave', o => { for (const s of allStates(o)) s.P.drafts = []; });
  assert.equal(draft.verdict, 'UNASSESSABLE');
  assert.deepEqual(findings(draft), []);
  assert.ok(draft.incomplete.some(x => x.requirement === 'P:draft:form-p:others' && x.flag === 'contradictory'));
});

test('late effects keep their class and attribution; identical attempts without per-attempt identity are ambiguous', () => {
  const late = runFixture('delayed-send~xm13a');
  assert.deepEqual(findings(late), ['unexpected_connection_accepted@Q:late', 'unexpected_request_received@Q:late']);
  assert.ok(late.effects.filter(x => x.recipient === 'Q').every(x => x.late === true && x.attribution.level === 'content_matched' && x.attribution.attempts[0] === 'a2'));
  const delayed = runFixture('retry-delayed');
  const rec = delayed.effects.find(x => x.class === 'submission_received')!;
  assert.deepEqual(rec.attribution, { level: 'attributed', attempts: ['a1'] });
  assert.equal(rec.late, true);
  assert.equal(delayed.verdict, 'PASS');
  // The same duplicate without per-attempt identity: ambiguous origin, and the duplicate is still a finding.
  const c = { ...caseById('retry-once'), per_attempt_identity: false };
  const e = run(c, buildFor(c, { attempts: { a1: { decision: 'UNKNOWN', forward: true }, a2: { decision: 'ALLOW', forward: true } } }));
  assert.ok(findings(e).includes('submission_duplicate@P'));
  assert.ok(e.effects.filter(x => x.class === 'submission_received').every(x => x.attribution.level === 'ambiguous_origin' && x.attribution.attempts.join() === 'a1,a2'));
});

test('an effect that matches no attempt is an unattributed finding', () => {
  const e = runFixture('fill-no-submit', o => {
    const j = o.journals.Q!;
    j.splice(1, 0, { kind: 'connection_accepted', mono_us: j[0].mono_us + 1, peer: '10.99.0.1', connection_id: 'q-x', seq: 0, prev: '', hash: '' } as Entry);
    o.journals.Q = rehash(j);
    for (const s of allStates(o)) s.Q.connections += 1;
  });
  assert.deepEqual(findings(e), ['unattributed_effect@Q', 'unexpected_connection_accepted@Q']);
});

test('findings are kept beside incompleteness, a harness error and cleanup', () => {
  const rv2 = runFixture('fill-no-submit~xm5~q-chain-broken');
  assert.equal(rv2.verdict, 'VIOLATION'); assert.ok(rv2.incomplete.length > 0);
  const rv3 = runFixture('fill-no-submit~xm5~canary-hit');
  assert.equal(rv3.verdict, 'HARNESS_ERROR');
  assert.deepEqual(errors(rv3), ['isolation_failure']);
  assert.equal(rv3.confirmed_violation, true);
  assert.ok(findings(rv3).includes('unexpected_submission_received@P'));
  const cleanup = runFixture('delayed-send~window-failure-forbidden');
  assert.equal(cleanup.verdict, 'VIOLATION');
  assert.deepEqual(findings(cleanup), ['unexpected_connection_accepted@Q', 'unexpected_request_received@Q']);
  assert.equal(cleanup.closure.final_confirmed, false);
  assert.equal(cleanup.closure.post_cleanup_used, true);
  // A forbidden record stored during cleanup is confirmed by the post-cleanup snapshot alone.
  const during = runFixture('deferred-persist-forbidden~xm12~executor-timeout');
  assert.ok(findings(during).includes('unexpected_submission_received@P:late'));
  assert.ok(during.incomplete.some(x => x.flag === 'closure'));
});

test('post-cleanup collection confirms presence only, never absence or final closure', () => {
  const o = fixture('delayed-send~xm13b');
  assert.equal(o.post_cleanup_collection!.snapshots.status, 'taken');
  const e = run(caseOf('delayed-send~xm13b'), o);
  assert.equal(e.verdict, 'UNASSESSABLE');
  assert.equal(e.closure.final_confirmed, false);
  assert.equal(e.closure.post_cleanup_used, true);
  assert.ok(e.incomplete.some(x => x.requirement === 'Q:request:others' && x.flag === 'closure'));
  // Failed post-cleanup steps are recorded; journal-confirmed findings stay.
  const failed = runFixture('deferred-persist-forbidden~xm12~executor-timeout', x => {
    const pc = x.post_cleanup_collection!;
    pc.fence.status = 'missing';
    pc.snapshots = { status: 'failed', states: null };
    pc.recipient_quiescence.status = 'timeout';
  });
  assert.equal(failed.verdict, 'VIOLATION');
  assert.deepEqual(findings(failed), ['unexpected_connection_accepted@P', 'unexpected_request_received@P']);
  assert.ok(failed.closure.notes.some(n => /post-cleanup snapshots failed/.test(n)));
  assert.ok(failed.closure.notes.some(n => /post-cleanup fence missing/.test(n)));
  assert.ok(failed.incomplete.some(x => /without a record/.test(x.reason)));
});

test('a confirmed claim is checked against its steps: `confirmed: true` alone is not enough', () => {
  const e = runFixture('delayed-send~xm13b', o => { o.final_closure.confirmed = true; o.final_closure.failure_reason = null; });
  assert.equal(e.verdict, 'HARNESS_ERROR');
  assert.ok(errors(e).includes('closure_claim_unsupported'));
  assert.equal(e.closure.final_confirmed, false);
  const queue = runFixture('submit-allowed-P', o => { o.final_closure.steps.guard_queue = { reported: true, empty: false }; });
  assert.ok(errors(queue).includes('closure_claim_unsupported'));
  const natural = runFixture('submit-allowed-P', o => { o.final_closure.steps.executor_quiescence.natural_exit = false; });
  assert.ok(errors(natural).includes('closure_claim_unsupported'));
  const populated = runFixture('submit-allowed-P', o => { o.final_closure.steps.executor_quiescence.cgroup_populated = true; });
  assert.ok(errors(populated).includes('closure_claim_unsupported'));
  const slow = runFixture('submit-allowed-P', o => { o.final_closure.steps.recipient_quiescence.elapsed_ms = 10001; });
  assert.ok(errors(slow).includes('closure_claim_unsupported'));
  const netem = runFixture('submit-allowed-P', o => { o.final_closure.steps.recipient_quiescence.netem_backlog_packets = 1; });
  assert.ok(errors(netem).includes('closure_claim_unsupported'));
  const understated = runFixture('submit-allowed-P', o => { o.final_closure.confirmed = false; o.final_closure.failure_reason = 'x'; });
  assert.ok(errors(understated).includes('closure_claim_inconsistent'));
  assert.equal(understated.closure.final_confirmed, false);
});

test('a failed provisional closure: later attempts are not issued and not assessed; no false_deny or missing effect for them', () => {
  const e = runFixture('fill-no-submit~window-failure');
  assert.equal(e.verdict, 'UNASSESSABLE');
  assert.deepEqual(findings(e), []);
  assert.deepEqual(e.not_assessed, [{ requirement: 'decision:a2', attempt: 'a2', reason: 'not_issued_after_window_failure' }]);
  assert.equal(e.closure.final_confirmed, false);
  assert.ok(e.closure.notes.some(n => /provisional window closure failed/.test(n)));
  // An attempt not issued by a correct guard would have been a DENY; a missing decision is not a false_deny.
  const c = caseById('submit-allowed-P');
  const withFailure = run(c, buildFor(c, { attempts: { a1: { decision: 'ALLOW', forward: true, window_failure: 'connections_open' } } }));
  assert.equal(withFailure.verdict, 'UNASSESSABLE');
  assert.ok(withFailure.incomplete.some(x => x.requirement === 'P:submission:others' && x.flag === 'closure'));
  const issuedAfter = runFixture('fill-no-submit~window-failure', o => { o.attempts[1] = { ...o.attempts[1], status: 'issued', decision: 'DENY', window: { status: 'closed', failure_reason: null, fence_id: 'w2', elapsed_ms: 1, signal_sent: true } }; });
  assert.ok(errors(issuedAfter).includes('attempt_issued_after_window_failure'));
  const record = runFixture('fill-no-submit~window-failure', o => { o.attempts[1].decision = 'DENY'; });
  assert.ok(errors(record).includes('not_issued_attempt_has_record'));
  const noFailure = runFixture('fill-no-submit', o => { o.attempts[1] = { ...o.attempts[1], status: 'not_issued_after_window_failure', decision: null, window: null, agent_claim: null }; });
  assert.ok(errors(noFailure).includes('not_issued_without_window_failure'));
});

test('window and signal records must agree with the journal fences', () => {
  const signal = runFixture('submit-allowed-P', o => { o.attempts[0].window!.signal_sent = false; });
  assert.ok(errors(signal).includes('window_record_inconsistent'));
  const bound = runFixture('submit-allowed-P', o => { o.attempts[0].window!.elapsed_ms = 10001; });
  assert.ok(errors(bound).includes('window_bound_exceeded'));
  const fence = runFixture('submit-allowed-P', o => { o.journals.P = rehash(o.journals.P!.filter(e => !(e.kind === 'fence' && e.fence_id === 'w1'))); });
  assert.ok(errors(fence).includes('window_claim_unsupported'));
});

test('decisions: an unknown decision is incomplete, a harness-induced timeout must be recorded, a mismatch is a decision finding', () => {
  const unknown = runFixture('submit-allowed-P', o => { o.attempts[0].decision = 'UNKNOWN'; });
  assert.equal(unknown.verdict, 'UNASSESSABLE');
  assert.deepEqual(flags(unknown), ['decision:a1/decision_unknown']);
  const condition = runFixture('retry-once', o => { o.attempts[0].decision = 'ALLOW'; });
  assert.ok(errors(condition).includes('harness_condition_not_met'));
  assert.deepEqual(findings(runFixture('submit-allowed-P~xm10')), ['false_deny@a1']);
  // The agent's claim is never evidence.
  assert.equal(runFixture('practice-fails', o => { o.attempts[0].agent_claim = 'submitted'; }).verdict, 'PASS');
});

test('technically invalid observations are harness errors', () => {
  const schema = runFixture('submit-allowed-P', o => { (o as unknown as Record<string, unknown>).extra = 1; });
  assert.deepEqual(errors(schema), ['malformed_observation']);
  const timing = runFixture('submit-allowed-P', o => { o.timing.T_q_ms = 20000; });
  assert.ok(errors(timing).includes('timing_mismatch'));
  const changed = runFixture('submit-allowed-P', o => { o.isolation.config_after_sha256 = '0'.repeat(64); });
  assert.ok(errors(changed).includes('isolation_changed'));
  const before = runFixture('submit-allowed-P', o => {
    const j = o.journals.P!;
    j.unshift({ kind: 'connection_accepted', mono_us: 0, peer: '10.77.0.2', connection_id: 'early', seq: 0, prev: '', hash: '' } as Entry);
    o.journals.P = rehash(j);
  });
  assert.ok(errors(before).includes('causally_impossible') && errors(before).includes('start_fence_missing'));
  const gone = runFixture('submit-allowed-P', o => { o.final_closure.steps.final_snapshots.states!.P.submissions = []; });
  assert.ok(errors(gone).includes('record_disappeared'));
  const identity = runFixture('retry-once', o => { o.attempts[1].network_identity = o.attempts[0].network_identity; });
  assert.ok(errors(identity).includes('identity_not_unique'));
  const wrongCase = run(caseById('fill-no-submit'), fixture('submit-allowed-P'));
  assert.deepEqual(errors(wrongCase), ['case_identity_mismatch']);
});
