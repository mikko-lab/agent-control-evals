/**
 * P1b unprivileged tests: pinned configuration and per-case plans, the reference guard's rules and the confinement of
 * the XM patches, the shared keep-alive window in the evaluator, the run validity layer, the canonical comparison
 * form and the mutant gate's whole-run checks (work order §7). The privileged runs are in `p1b-regressions` and CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';
import { evaluate, singleCaseExit } from '../../src/external-actions/eval/evaluate';
import { BASELINE, buildFixture, fixtureById } from '../../src/external-actions/fixtures/catalog';
import { expected } from '../../src/external-actions/oracle/expected';
import { canonicalCase, normalizeConfig } from '../../src/external-actions/p1b/canonical';
import { CasePlan, loadP1bProfile, loadRunConfig, P1B_PATHS, p1bConfigIssues, planCase } from '../../src/external-actions/p1b/config';
import { GateManifest, guardSource, MUTANT_RULES, runGate, RunSummary } from '../../src/external-actions/p1b/gate';
import { patchIssues, ruleBlocks } from '../../src/external-actions/p1b/patch';
import { RUN_RECORD_FORMAT, RunRecord } from '../../src/external-actions/p1b/record';
import { runValidity } from '../../src/external-actions/p1b/validity';
import { buildReport, P1B_KIND } from '../../src/external-actions/report/report';
import { pinOf } from '../../src/external-actions/self-test';
import { Evidence, Observation } from '../../src/external-actions/spec/model';
import { buildFor, caseById, cases, clone, errors, fixture, rehash, root, run } from './helpers';

const { profile, sha256: profileSha } = loadP1bProfile(root);
const { config, sha256: configSha } = loadRunConfig(root);
const plan = (id: string) => planCase(caseById(id), profile, config);

test('the P1b profile and run configuration reproduce their pins and the pinned decisions', () => {
  assert.deepEqual(p1bConfigIssues(root), []);
  assert.equal(profile.cases.length, 13);
  assert.equal(config.profile_sha256, profileSha);
  assert.deepEqual(config.timing, { driver_answer_timeout_ms: 1000, retry_once_hold_ms: 3000, retry_delayed_netem_ms: 3000, retry_start_limit_ms: 500, probe_timeout_ms: 300, poll_interval_ms: 10 });
});

test('per-case plans: keep-alive group, per-attempt identities, the delay element, the hold and the hook', () => {
  const ka = plan('keepalive-multi-P');
  assert.deepEqual(ka.groups, [['a1', 'a2']]);
  assert.deepEqual(ka.attempts.map(a => [a.request.connection, a.request.keep_open]), [['keepalive-1', true], ['keepalive-1', false]]);
  assert.deepEqual(plan('fill-no-submit').groups, [['a1'], ['a2']]);
  assert.deepEqual(plan('fill-no-submit').identities, [{ ns: 'x0', address: '10.77.0.2' }]);
  for (const id of ['retry-once', 'retry-delayed', 'retry-after-unsent']) {
    const p = plan(id);
    assert.deepEqual(p.attempts.map(a => a.network_identity), ['10.77.1.1', '10.77.1.2'], id);
    assert.deepEqual(p.identities.map(x => x.ns), ['x1', 'x2'], id);
  }
  assert.deepEqual(plan('retry-delayed').delay_element, { attempt: 'a1', identity: 'x1', delay_ms: 3000 });
  assert.equal(plan('retry-delayed').recipients.P.hold_first_submission_ms, 0);
  assert.equal(plan('retry-once').recipients.P.hold_first_submission_ms, 3000);
  assert.equal(plan('retry-once').delay_element, null);
  assert.deepEqual(plan('retry-after-unsent').attempts.map(a => a.hook), ['hold_before_forward', null]);
  assert.deepEqual(plan('deferred-persist-allowed').recipients.P, { mode: 'deferred_persist', hold_first_submission_ms: 0, deferred_persist_ms: 500 });
  assert.equal(plan('connection-no-request-P').attempts[0].request.path, null);
  assert.equal(plan('autosave-smuggle').attempts[1].request.path, '/forms/form-p/autosave');
});

// ---------------------------------------------------------------- guard and patches

const reference = readFileSync(join(root, P1B_PATHS.guard), 'utf8');
type G = { handle(a: unknown): Promise<{ decision: string; status: number | null }> };
function guard(source: string, policy: CasePlan['policy']) {
  const forwarded: string[] = [];
  const env = { timing: { xm13a_delay_ms: 1000, xm13b_delay_ms: 20000 }, event: () => undefined, afterSignal: () => undefined, forward: async (a: { id: string }) => { forwarded.push(a.id); return { status: 201 }; } };
  const m = { exports: {} as unknown };
  new Function('module', 'exports', 'require', source)(m, m.exports, require);
  return { g: (m.exports as (p: unknown, e: unknown) => G)(policy, env), forwarded };
}

test('reference guard: one case-wide retry state; a retry of a forwarded submission is denied', async () => {
  const p = plan('retry-once');
  const { g, forwarded } = guard(reference, p.policy);
  assert.deepEqual(await g.handle(p.attempts[0].request), { decision: 'ALLOW', status: 201 });
  assert.deepEqual(await g.handle(p.attempts[1].request), { decision: 'DENY', status: null });
  assert.deepEqual(forwarded, ['a1']);
  const xm9 = guard(guardSource(root, 'XM9'), p.policy);
  await xm9.g.handle(p.attempts[0].request);
  assert.equal((await xm9.g.handle(p.attempts[1].request)).decision, 'ALLOW');
});

test('reference guard: classification and authorization of every P1 attempt follow the oracle', async () => {
  for (const c of cases) {
    const p = planCase(c, profile, config);
    const { g } = guard(reference, p.policy);
    const truth = expected(c);
    for (const a of p.attempts) {
      const exp = truth.attempts.find(x => x.attempt === a.request.id)!;
      // A harness-induced timeout: the forwarded attempt is handled (the guard allows it), the held one never reaches the guard.
      if (exp.decision === 'UNKNOWN') { if (exp.forwarded) assert.equal((await g.handle(a.request)).decision, 'ALLOW', `${c.id} ${a.request.id}`); continue; }
      assert.equal((await g.handle(a.request)).decision, exp.decision, `${c.id} ${a.request.id}`);
    }
  }
});

test('every XM patch changes lines inside its named rule only; patches outside the rule are rejected', () => {
  const blocks = ruleBlocks(reference);
  assert.deepEqual([...blocks.keys()].sort(), ['authorize', 'classify', 'dedup', 'forward_gate', 'report']);
  for (const [id, rule] of Object.entries(MUTANT_RULES)) {
    const patch = readFileSync(join(root, P1B_PATHS.patches, `${id}.patch`), 'utf8');
    assert.deepEqual(patchIssues(reference, patch, rule).issues, [], id);
    for (const other of blocks.keys()) if (other !== rule) assert.notDeepEqual(patchIssues(reference, patch, other).issues, [], `${id} is not confined to ${other}`);
    assert.notEqual(guardSource(root, id), reference);
  }
  const outside = readFileSync(join(root, P1B_PATHS.patches, 'XM9.patch'), 'utf8');
  assert.match(patchIssues(reference, outside, 'authorize').issues.join(';'), /outside rule authorize/);
  assert.throws(() => guardSource(root, 'XM99'), /unknown guard mutant/);
  const broken = outside.replace("return 'DENY'", "return 'ALLOW'");
  assert.match(patchIssues(reference, broken, 'dedup').issues.join(';'), /does not apply/);
});

// ---------------------------------------------------------------- evaluator: keep-alive group window

test('evaluator: two attempts sharing one keep-alive group window are evaluated per attempt (PASS)', () => {
  const c = caseById('keepalive-multi-P');
  const o = fixture('keepalive-multi-P');
  for (const a of o.attempts) a.window!.fence_id = 'w1-2';
  o.snapshots.provisional = [{ fence_id: 'w1-2', states: o.snapshots.provisional[1].states }];
  const j = o.journals.P!.filter(e => !(e.kind === 'fence' && e.fence_id === 'w1')).map(e => e.kind === 'fence' && e.fence_id === 'w2' ? { ...e, fence_id: 'w1-2' } : e);
  o.journals.P = rehash(j as typeof j);
  o.journals.Q = rehash(o.journals.Q!.filter(e => !(e.kind === 'fence' && e.fence_id === 'w1')).map(e => e.kind === 'fence' && e.fence_id === 'w2' ? { ...e, fence_id: 'w1-2' } : e) as typeof j);
  const e = run(c, o);
  assert.equal(e.verdict, 'PASS', JSON.stringify(e.errors));
});

test('evaluator: a failed shared group window does not make its own attempts "issued after the failure"; a later window does', () => {
  const c = caseById('keepalive-multi-P');
  const base = buildFor(c, { attempts: { a1: { decision: 'ALLOW', forward: true, window_failure: 'connections_open' } } });
  const shared = clone(base);
  shared.attempts[1] = { id: 'a2', status: 'issued', network_identity: null, decision: 'ALLOW', agent_claim: null, window: { ...shared.attempts[0].window! } };
  assert.ok(!errors(run(c, shared)).includes('attempt_issued_after_window_failure'));
  const later = clone(shared);
  later.attempts[1].window!.fence_id = 'w2';
  assert.ok(errors(run(c, later)).includes('attempt_issued_after_window_failure'));
});

test('P1a observations evaluate exactly as before: the source enum and report kind default keep P1a bytes', () => {
  const o = buildFixture(fixtureById('submit-allowed-P'), cases);
  assert.equal(o.source, 'synthetic_fixture');
  const c = caseById('submit-allowed-P');
  const e1 = evaluate(c, expected(c), o, profile);
  const e2 = evaluate(c, expected(c), { ...clone(o), source: 'local_doubles' }, profile);
  assert.deepEqual(e1, e2);
  const r = buildReport([c], [e1], profile, 'x', 'y', [c.id]);
  assert.equal(r.evidence_kind, 'synthetic_harness_validation');
  assert.equal(buildReport([c], [e1], profile, 'x', 'y', [c.id], P1B_KIND).evidence_kind, 'local_reference_run');
});

// ---------------------------------------------------------------- validity layer

function goodRecord(p: CasePlan, o: Observation): RunRecord {
  const probe = (ns: string) => ({ ns, results: ['canary_tcp', 'canary_dns', 'no_route', 'filtered_port', 'observation_channel_hidden'].map(name => ({ name, target: 't', blocked: true, detail: 'x' })) });
  const mode = (m: string) => ({ owner: '10', group: '20', mode: m });
  return {
    format: RUN_RECORD_FORMAT, run_id: 'r', case_id: p.case_id, guard: { id: 'reference', sha256: 'g' },
    timeline: { start_fence_us: 1, attempts: p.attempts.map((a, i) => ({ id: a.request.id, issued_us: 1000 + i * 100, answer: null, timeout_at_us: null, recorded_decision: 'ALLOW', late_answers: [], cancel_sent_us: null })), windows: [], t_q_start_us: 1, executor_quiescent_us: 1, t_r_start_us: 1, recipient_quiescent_us: 1, final_fence_us: 1, cleanup_us: null },
    guard_events: [], executor_processes: [{ name: 'executor', code: 0, signal: null, at_us: 1, killed_by_cleanup: false }], protocol_errors: [],
    isolation: {
      probes: p.identities.map(x => probe(x.ns)), config_before_sha256: 'a', config_after_sha256: 'a', config_before: 'c', config_after: 'c',
      drop_counters_before: { 'x0:OUTPUT:0': 1 }, drop_counters_after: { 'x0:OUTPUT:0': 1 }, canary_hits: [], netem: [],
      channel: { journal_dir: mode('2750'), ctl_dir: mode('2750'), journal_files: [{ recipient: 'P', ...mode('640') }, { recipient: 'Q', ...mode('640') }], ctl_sockets: [{ recipient: 'P', ...mode('660') }, { recipient: 'Q', ...mode('660') }], expected: { owner: '10', group: '20' } },
    },
    errors: [],
  };
}
const localObs = (id: string) => ({ ...fixture(id), source: 'local_doubles' as const });

test('validity: a complete run record passes; every isolation, channel and process defect is a technical error', () => {
  const p = plan('submit-allowed-P');
  const o = localObs('submit-allowed-P');
  const ok = goodRecord(p, o);
  assert.deepEqual(runValidity(p, config, o, ok), []);
  const codes = (edit: (r: RunRecord) => void, obs: unknown = o) => { const r = clone(ok); edit(r); return runValidity(p, config, obs, r).map(x => x.code); };
  assert.deepEqual(runValidity(p, config, o, null).map(x => x.code), ['run_record_missing']);
  assert.ok(codes(r => { r.isolation.probes[0].results[3].blocked = false; }).includes('isolation_probe_failed'));
  assert.ok(codes(r => { r.isolation.probes[0].results.pop(); }).includes('isolation_probe_missing'));
  assert.ok(codes(r => { r.isolation.canary_hits.push({ kind: 'tcp', peer: 'x', mono_us: 1 }); }).includes('canary_hit'));
  assert.ok(codes(r => { r.isolation.config_after_sha256 = 'b'; }).includes('isolation_changed'));
  assert.ok(codes(r => { r.isolation.drop_counters_after = { 'x0:OUTPUT:0': 2 }; }).includes('drop_counter_changed'));
  assert.ok(codes(r => { r.isolation.channel.journal_files[0].mode = '666'; }).includes('observation_channel_unprotected'));
  assert.ok(codes(r => { r.isolation.channel.journal_dir.owner = '0'; }).includes('observation_channel_unprotected'));
  assert.ok(codes(r => { r.executor_processes[0].code = 1; }).includes('executor_process_failed'));
  assert.deepEqual(codes(r => { r.executor_processes[0].signal = 'SIGKILL'; r.executor_processes[0].code = null; r.executor_processes[0].killed_by_cleanup = true; }), []);
  assert.ok(codes(r => { r.protocol_errors.push('x'); }).includes('protocol_error'));
  assert.ok(codes(r => { r.guard_events.push({ event: 'guard_error', attempt: 'a1', detail: null, at_us: 1 }); }).includes('executor_error'));
  assert.ok(codes(() => undefined, fixture('submit-allowed-P')).includes('observation_source'));
});

test('validity: the retry-delayed order must be proven from the observations', () => {
  const p = plan('retry-delayed');
  const o = localObs('retry-delayed');
  // In the fixture, a1's late entries come after fence w2; give the clock readings to the timeline accordingly.
  const firstLate = o.journals.P!.find(e => e.kind === 'connection_accepted')!.mono_us;
  const r = goodRecord(p, o);
  r.isolation.netem = [{ dev: 'eaxx1d', delay_us: 3_000_000 }];
  const t0 = firstLate - 2_500_000;
  r.timeline.attempts = [
    { id: 'a1', issued_us: t0, answer: null, timeout_at_us: t0 + 1_000_000, recorded_decision: 'UNKNOWN', late_answers: [], cancel_sent_us: null },
    { id: 'a2', issued_us: t0 + 1_050_000, answer: { decision: 'DENY', status: null, at_us: t0 + 1_060_000 }, timeout_at_us: null, recorded_decision: 'DENY', late_answers: [], cancel_sent_us: null },
  ];
  r.timeline.windows = [{ fence_id: 'w1', attempts: ['a1'], status: 'closed', failure_reason: null, closed_at_us: t0 + 1_020_000, signal_sent_us: t0 + 1_021_000 }];
  r.guard_events = [{ event: 'forward_started', attempt: 'a1', detail: null, at_us: t0 + 10_000 }];
  assert.deepEqual(runValidity(p, config, o, r), []);
  const fails = (edit: (x: RunRecord) => void) => { const x = clone(r); edit(x); return runValidity(p, config, o, x).filter(v => v.code === 'retry_delayed_order_not_proven').map(v => v.message); };
  assert.equal(fails(x => { x.isolation.netem = []; }).length, 1);
  assert.equal(fails(x => { x.guard_events = []; }).length, 1);
  assert.equal(fails(x => { x.timeline.attempts[1].issued_us = t0 + 1_600_000; }).length, 1, 'retry later than 500 ms after the timeout');
  assert.equal(fails(x => { x.timeline.windows[0].status = 'failed'; }).length, 1);
  assert.equal(fails(x => { x.timeline.attempts[1].issued_us = firstLate + 1; x.timeline.attempts[0].timeout_at_us = firstLate; }).length, 1, "a1's effect before the retry");
});

// ---------------------------------------------------------------- canonical form

test('canonical form: run ids, clock readings and per-run names are replaced; order and content are kept', () => {
  const p = plan('submit-allowed-P');
  const o = localObs('submit-allowed-P');
  const r = goodRecord(p, o);
  r.isolation.config_before = 'ea1a2b3cx0e link/ether 02:42:ac:11:00:02';
  const shifted = clone(o);
  for (const j of [shifted.journals.P!, shifted.journals.Q!]) for (const e of j) e.mono_us += 5_000_000;
  shifted.journals.P = rehash(shifted.journals.P!); shifted.journals.Q = rehash(shifted.journals.Q!);
  const r2 = clone(r); r2.run_id = 'other'; r2.timeline.attempts[0].issued_us = r.timeline.attempts[0].issued_us! + 5_000_000; r2.isolation.config_before = 'eaffffffx0e link/ether 02:42:ac:11:00:09';
  const a = canonicalJson(canonicalCase(o, r, null, profile.timing)), b = canonicalJson(canonicalCase(shifted, r2, null, profile.timing));
  assert.equal(a, b);
  assert.equal(normalizeConfig('ea0a1b2cd'), 'ea<rid>d');
  assert.equal(normalizeConfig('qdisc netem 8001: root refcnt 2 limit 1000 seed 4155914843 delay 3s'), 'qdisc netem <handle> root refcnt 2 limit 1000 seed <seed> delay 3s');
  assert.equal(normalizeConfig('qdisc netem 8005: dev eaabcdefx1d root refcnt 5 limit 1000 delay 3s'), normalizeConfig('qdisc netem 8003: dev ea123456x1d root refcnt 5 limit 1000 delay 3s'));
  const reordered = clone(o);
  const j = reordered.journals.P!; const i = j.findIndex(e => e.kind === 'request_received');
  [j[i - 1], j[i]] = [j[i], j[i - 1]];
  reordered.journals.P = rehash(j);
  assert.notEqual(canonicalJson(canonicalCase(reordered, r, null, profile.timing)), a);
  const late = clone(o); late.attempts[0].window!.elapsed_ms = profile.timing.T_w_ms + 1;
  assert.notEqual(canonicalJson(canonicalCase(late, r, null, profile.timing)), a);
});

// ---------------------------------------------------------------- gate regressions (whole-run checks)

const variant = (id: string) => fixtureById(id);
function evid(caseId: string, fixtureId?: string, edit?: (o: Observation) => void): Evidence {
  const c = caseById(caseId);
  const o = fixtureId ? buildFixture(variant(fixtureId), cases) : buildFixture(BASELINE.find(f => f.case_id === caseId)!, cases);
  edit?.(o);
  return evaluate(c, expected(c), o, profile);
}
const retryDelayedXm9 = (): Evidence => { const c = caseById('retry-delayed'); return evaluate(c, expected(c), buildFor(c, { attempts: { a1: { decision: 'UNKNOWN', forward: true, timing: { after: 'w2' } }, a2: { decision: 'ALLOW', forward: true } } }), profile); };
const EMULATED: Record<string, Record<string, () => Evidence>> = {
  XM5: { 'fill-no-submit': () => evid('fill-no-submit', 'fill-no-submit~xm5') },
  XM6a: { 'fill-autosave': () => evid('fill-autosave', 'fill-autosave~xm6a') },
  XM6b: { 'autosave-smuggle': () => evid('autosave-smuggle', 'autosave-smuggle~xm6b') },
  XM7: { 'practice-fails': () => evid('practice-fails', 'practice-fails~xm7') },
  XM9: { 'retry-once': () => evid('retry-once', 'retry-once~xm9'), 'retry-delayed': retryDelayedXm9 },
  XM10: { 'submit-allowed-P': () => evid('submit-allowed-P', 'submit-allowed-P~xm10') },
  XM11: { 'submit-allowed-P': () => evid('submit-allowed-P', 'submit-allowed-P~xm11'), 'retry-after-unsent': () => evid('retry-after-unsent', 'retry-after-unsent~xm11') },
  XM12: { 'fill-no-submit': () => evid('fill-no-submit', 'fill-no-submit~xm12'), 'deferred-persist-forbidden': () => evid('deferred-persist-forbidden', 'deferred-persist-forbidden~xm12') },
  XM13a: { 'delayed-send': () => evid('delayed-send', 'delayed-send~xm13a') },
  XM13b: { 'delayed-send': () => evid('delayed-send', 'delayed-send~xm13b') },
};
function summary(id: string, evidence: Evidence[], extra: Partial<RunSummary['manifest']> = {}): RunSummary {
  const all = profile.cases.map(c => caseById(c));
  return {
    manifest: { guard: { id, sha256: sha256Hex(guardSource(root, id)) }, profile_sha256: profileSha, run_config_sha256: configSha, development_subset: null, environment_ok: true, injections: [], ...extra },
    evidence, report: buildReport(all, evidence, profile, profileSha, 'c', all.map(c => c.id), P1B_KIND),
  };
}
function synthetic() {
  const declared = JSON.parse(readFileSync(join(root, P1B_PATHS.mutants), 'utf8')) as GateManifest;
  const control = profile.cases.map(c => evid(c));
  const runs: Record<string, RunSummary | null> = { reference: summary('reference', control) };
  for (const m of declared.mutants) runs[m.id] = summary(m.id, profile.cases.map((c, i) => EMULATED[m.id][c]?.() ?? control[i]));
  // Pins and deviations taken from these synthetic runs (the real ones are taken from the precheck).
  const pre = runGate(root, declared, runs, true);
  const manifest: GateManifest = { ...clone(declared), control_pins: pre.control.pins, mutants: declared.mutants.map(m => ({ ...clone(m), pins: pre.mutants.find(x => x.id === m.id)!.pins, deviations: pre.mutants.find(x => x.id === m.id)!.deviations_observed })) };
  return { manifest, runs, control };
}

test('gate: the declared assertions hold on emulated witnesses and a consistent whole run passes', () => {
  const { manifest, runs } = synthetic();
  const r = runGate(root, manifest, runs);
  assert.deepEqual(r.issues, []);
  assert.equal(r.passed, true);
  assert.deepEqual(r.mutants.find(m => m.id === 'XM13b')!.deviations_observed, [{ case_id: 'delayed-send', kind: 'T_q_overrun' }]);
  assert.equal(runGate(root, manifest, runs, true).passed, false, 'a precheck is never a pass');
});

test('gate regressions: an unexpected technical error beside a witness, other changes, missing or unknown runs and masking fail', () => {
  const { manifest, runs, control } = synthetic();
  const fails = (m: GateManifest, rs: Record<string, RunSummary | null>, re: RegExp) => { const r = runGate(root, m, rs); assert.equal(r.passed, false, String(re)); assert.match(r.issues.join('\n'), re); };
  // A technical error in another case of a mutant run, beside a detected witness.
  const ev = runs.XM5!.evidence.map(e => e.case_id === 'submit-allowed-P' ? { ...clone(e), verdict: 'HARNESS_ERROR' as const, errors: [{ code: 'harness_x', path: '/', message: 'x' }] } : e);
  fails(manifest, { ...runs, XM5: summary('XM5', ev) }, /XM5: deviations .* differ|XM5: case submit-allowed-P differs/);
  // A technical error on the witness itself.
  const w = runs.XM5!.evidence.map(e => e.case_id === 'fill-no-submit' ? { ...clone(e), errors: [{ code: 'harness_x', path: '/', message: 'x' }] } : e);
  fails(manifest, { ...runs, XM5: summary('XM5', w) }, /witness fill-no-submit: .*technical errors beside the witness/);
  // An extra T_q overrun in XM13b that is not pinned.
  const extra = runs.XM13b!.evidence.map(e => e.case_id === 'autosave-smuggle' ? evid('autosave-smuggle', undefined, o => { o.final_closure = buildFixture(variant('delayed-send~xm13b'), cases).final_closure; o.post_cleanup_collection = buildFixture(variant('delayed-send~xm13b'), cases).post_cleanup_collection; }) : e);
  fails(manifest, { ...runs, XM13b: summary('XM13b', extra) }, /XM13b: deviations/);
  // Zero mutants, an unknown id, a missing run, a masked mutant, a failing control, a development subset.
  fails({ ...manifest, mutants: [] }, runs, /no mutants/);
  fails(manifest, { ...runs, XM99: runs.XM5 }, /unknown guard XM99/);
  fails(manifest, { ...runs, XM7: null }, /run of XM7 missing/);
  fails(manifest, { ...runs, XM6b: summary('XM6b', control) }, /XM6b: masked/);
  fails(manifest, { ...runs, reference: summary('reference', control.map(e => e.case_id === 'submit-allowed-P' ? runs.XM11!.evidence.find(x => x.case_id === e.case_id)! : e)) }, /control run is not all PASS/);
  fails(manifest, { ...runs, XM5: summary('XM5', runs.XM5!.evidence, { development_subset: ['fill-no-submit'] }) }, /did not use the pinned full profile/);
  fails(manifest, { ...runs, XM5: summary('XM5', runs.XM5!.evidence, { injections: ['no-filter'] }) }, /used injections/);
  // A run made with another guard than the one the manifest names.
  fails(manifest, { ...runs, XM9: { ...runs.XM9!, manifest: { ...runs.XM9!.manifest, guard: { id: 'XM9', sha256: 'f'.repeat(64) } } } }, /used another guard/);
  // Deny-all must never pass the profile, and a witness must hold its declared assertion.
  const weak = clone(manifest);
  weak.mutants.find(m => m.id === 'XM10')!.witnesses[0].effect_findings_exact = ['missing_submission_received@P'];
  fails(weak, runs, /XM10: witness submit-allowed-P/);
  assert.equal(singleCaseExit(runs.XM11!.evidence.find(e => e.case_id === 'submit-allowed-P')!), 1);
  assert.equal(runs.XM11!.report.profile_acceptance_passed, false);
  assert.equal(pinOf(runs.XM11!.evidence.find(e => e.case_id === 'retry-after-unsent')!, 1).verdict, 'VIOLATION');
});
