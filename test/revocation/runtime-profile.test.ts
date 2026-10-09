/**
 * revocation-0.4.0 declared-profile tests that need no SUT: they evaluate the committed observations of the pinned
 * runtime's baseline run (test/fixtures/revocation-runtime, refreshed and byte-compared against a fresh run in
 * runtime-sut.test.ts) and controlled edits of them that simulate SUT behaviour the baseline does not show.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cases, root } from './helpers';
import { expected } from '../../src/oracle/revocation/expected';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { Case, Evidence, RuntimeObservation, VERSION } from '../../src/spec/revocation/model';
import { classify } from '../../src/profile/revocation/classifier';
import { controlSteps, loadProfile, loadSupplement, ProfileError } from '../../src/profile/revocation/profile';
import { buildProfileReport, profileExitCode } from '../../src/report/revocation/profile-report';
import { validateProfileReport } from '../../src/report/revocation/validate';
import { editProbes, markTerminal, probeIndex, rereport, writeCommit } from '../../src/mutation/revocation/adapter-mutants';
import { loadRevocationLock, RevocationLockError } from '../../src/sut/revocation-lock';
import { canonicalJsonLines } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';

const LOCK = 'sut.revocation.lock.json';
const { lock, sha256: lockSha256 } = loadRevocationLock(join(root, LOCK), VERSION);
const corpusSha = sha256Hex(canonicalJsonLines(cases));
const { profile, sha256: profileSha } = loadProfile(root, lock.profile, cases, corpusSha, VERSION, lock.sut_commit);
const { supplement, sha256: supplementSha } = loadSupplement(root, lock.supplement, VERSION, lock.sut_commit);
const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/revocation-runtime/a682e44-baseline-observations.json'), 'utf8')) as { corpus: RuntimeObservation[]; supplement: RuntimeObservation[] };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const caseOf = (id: string): Case => cases.find(c => c.id === id) ?? (() => { const s = supplement.cases.find(x => x.id === id)!; return { id: s.id, family: s.family, authorities: s.authorities, steps: s.steps }; })();
const truthOf = (id: string) => supplement.cases.find(x => x.id === id)?.expected ?? expected(caseOf(id));
const obsOf = (id: string) => clone([...fixture.corpus, ...fixture.supplement].find(o => o.case_id === id)!);
const ev = (id: string, o: RuntimeObservation) => evaluate(caseOf(id), truthOf(id), o, { ordering: 'probe_seq', controlSteps: controlSteps(caseOf(id)) });
const findings = (e: Evidence) => [...e.decision_findings, ...e.effect_findings].map(f => `${f.reason}@${f.step}`).sort();

function reportWith(over: Map<string, Evidence> = new Map(), prof = profile) {
  const evidence = new Map<string, Evidence>();
  for (const o of fixture.corpus) evidence.set(o.case_id, ev(o.case_id, o));
  for (const [id, e] of over) if (cases.some(c => c.id === id)) evidence.set(id, e);
  const supp = supplement.cases.map(c => ({ c, e: over.get(c.id) ?? ev(c.id, obsOf(c.id)) }));
  return buildProfileReport({
    corpus: cases, truths: cases.map(expected), corpus_sha256: corpusSha, observation_source: 'pinned_runtime_adapter', profile: prof, profile_sha256: profileSha, supplement_id: supplement.supplement, supplement_sha256: supplementSha,
    evidence, supplement: supp,
    sut: { repository: lock.sut_repository, commit: lock.sut_commit, tree: lock.sut_tree, version: lock.sut_version, lock_sha256: lockSha256, build_sha256: '0'.repeat(64), baseline_verified: false },
    harness_commit: null, harness_worktree_clean: false,
  });
}

test('profile: committed applicability equals the classifier (14 IN_PROFILE / 13 OUT_OF_SCOPE), with tested properties and caveats', () => {
  assert.equal(profile.cases.filter(c => c.applicability === 'IN_PROFILE').length, 14);
  assert.equal(profile.cases.filter(c => c.applicability === 'OUT_OF_SCOPE').length, 13);
  for (const c of cases) assert.equal(classify(c, expected(c)).applicability, profile.cases.find(p => p.id === c.id)!.applicability, c.id);
  assert.equal(profile.cases.find(c => c.id === 'permit-single-use')!.out_of_scope![0].capability_class, 'single_use_permit');
  for (const id of ['issued-permit', 'cut-before-start', 'duplicate-revocation', 'sibling-isolation']) assert.ok(profile.cases.find(c => c.id === id)!.family_caveat, id);
});

test('profile and supplement fail closed: golden bytes, classifier agreement and lock binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-profile-'));
  try {
    mkdirSync(join(dir, 'profiles/revocation'), { recursive: true });
    for (const f of readdirSync(join(root, 'profiles/revocation'))) copyFileSync(join(root, 'profiles/revocation', f), join(dir, 'profiles/revocation', f));
    const p = join(dir, lock.profile);
    const original = readFileSync(p, 'utf8');
    writeFileSync(p, original.replace('"IN_PROFILE"', '"OUT_OF_SCOPE"'));
    assert.throws(() => loadProfile(dir, lock.profile, cases, corpusSha, VERSION, lock.sut_commit), /committed golden/);
    writeFileSync(p.replace(/\.json$/, '.sha256'), sha256Hex(readFileSync(p)) + '\n');
    assert.throws(() => loadProfile(dir, lock.profile, cases, corpusSha, VERSION, lock.sut_commit), /differs from the classifier/);
    writeFileSync(p, original); writeFileSync(p.replace(/\.json$/, '.sha256'), sha256Hex(Buffer.from(original)) + '\n');
    assert.throws(() => loadProfile(dir, lock.profile, cases, corpusSha, VERSION, '0'.repeat(40)), ProfileError);
    const s = join(dir, lock.supplement);
    const supp = JSON.parse(readFileSync(s, 'utf8'));
    supp.cases[0].expected.decisions[1].decision = 'ALLOW';
    writeFileSync(s, JSON.stringify(supp)); writeFileSync(s.replace(/\.json$/, '.sha256'), sha256Hex(readFileSync(s)) + '\n');
    assert.throws(() => loadSupplement(dir, lock.supplement, VERSION, lock.sut_commit), /differ from the contract oracle/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lock: the revocation lock is validated fail closed and never falls back to sut.lock.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-lock-'));
  try {
    const good = JSON.parse(readFileSync(join(root, LOCK), 'utf8'));
    const bad: [string, Record<string, unknown>][] = [
      ['track', { track: 'acs' }], ['contract', { contract: 'revocation-0.3.0' }], ['sut_commit', { sut_commit: 'a682e44' }], ['sut_tree', { sut_tree: 'x' }],
      ['package lock', { sut_package_lock_sha256: 'abc' }], ['follow_upstream', { follow_upstream: true }],
    ];
    for (const [name, patch] of bad) {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify({ ...good, ...patch }));
      assert.throws(() => loadRevocationLock(join(dir, 'lock.json'), VERSION), RevocationLockError, name);
    }
    assert.equal(lock.sut_commit, 'a682e4479dbccd1cd5f665f5d4879bd3dddb8b47');
    assert.equal(JSON.parse(readFileSync(join(root, 'sut.lock.json'), 'utf8')).sut_commit, '403d31593a0d57187df3f5e1ef3df6127baaefb9');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('baseline: 14 PASS of 14 IN_PROFILE, 13 OUT_OF_SCOPE without verdict, supplement as declared, exit 3, never a contract pass', () => {
  const r = reportWith();
  assert.deepEqual(validateProfileReport(r), []);
  assert.equal(r.counts.PASS, 14); assert.equal(r.counts.in_profile, 14); assert.equal(r.counts.out_of_scope, 13); assert.equal(r.counts.corpus_total, 27);
  assert.equal(r.evidence.length, 27);
  for (const e of r.evidence.filter(x => x.applicability === 'OUT_OF_SCOPE')) assert.equal(e.verdict, null);
  assert.equal(r.counts.not_assessed_requirements, 34);
  assert.deepEqual(r.supplement.cases.map(s => [s.case_id, s.evidence.verdict, s.matches_declaration]), [
    ['sup-pending-approval-revoked', 'PASS', true], ['sup-pending-approval-control', 'PASS', true], ['sup-commit-after-terminal-no-revocation', 'PASS', true], ['sup-unobservable-pending-settlement', 'UNASSESSABLE', true],
  ]);
  const s4 = r.supplement.cases[3].evidence;
  assert.deepEqual(s4.incomplete, ['terminal evidence missing for e1 in window 1..2', 'execution not observed terminal: e1']);
  assert.equal(s4.decision_findings.length + s4.effect_findings.length + s4.errors.length, 0);
  assert.equal(r.contract_acceptance_passed, false); assert.equal(r.profile_acceptance_passed, true); assert.equal(r.supplement_acceptance_passed, true);
  assert.equal(r.technically_valid, true); assert.equal(profileExitCode(r), 3);
  assert.match(r.statement, /not a revocation-0\.4\.0 contract pass/);
});

test('acceptance arithmetic: a profile with all 27 cases IN_PROFILE that still skips finish/seal decisions is no contract pass (exit 3)', () => {
  const all = clone(profile);
  for (const c of all.cases) { c.applicability = 'IN_PROFILE'; c.tested_property ??= 'synthetic'; delete c.out_of_scope; }
  const pass = (id: string): Evidence => ({ case_id: id, family: caseOf(id).family, state_at_cut: [], verdict: 'PASS', confirmed_violation: false, decision_findings: [], effect_findings: [], incomplete: [], errors: [] });
  const r = reportWith(new Map(cases.map(c => [c.id, pass(c.id)])), all);
  assert.equal(r.counts.in_profile, 27); assert.equal(r.counts.PASS, 27); assert.ok(r.counts.not_assessed_requirements > 0);
  assert.equal(r.contract_acceptance_passed, false); assert.equal(profileExitCode(r), 3);
  // Only with nothing skipped would contract acceptance (exit 0) be reachable.
  for (const c of all.cases) c.not_assessed_requirements = [];
  const full = reportWith(new Map(cases.map(c => [c.id, pass(c.id)])), all);
  assert.equal(full.contract_acceptance_passed, true); assert.equal(profileExitCode(full), 0);
});

test('effect independence: observed effects stand whatever the API answered; disagreement is not a HARNESS_ERROR', () => {
  // (a) a managed-state write at a commit the runtime denied with CommitRejectedError
  const base = obsOf('in-flight-before-commit');
  const write = (o: RuntimeObservation, step: number) => editProbes(o, probeIndex(o, step, 'barrier_complete'), s => writeCommit(s, 'e1', 1));
  const a = ev('in-flight-before-commit', rereport(caseOf('in-flight-before-commit'), write(base, 3)));
  assert.deepEqual([a.verdict, findings(a), a.errors], ['VIOLATION', ['unexpected_tool_commit@3'], []]);
  // (b) the same write with a non-CommitRejectedError throw: UNKNOWN decision, the effect is still a finding
  const thrown = write(base, 3); thrown.calls.find(x => x.step === 3)!.class = 'other:TypeError';
  const b = ev('in-flight-before-commit', rereport(caseOf('in-flight-before-commit'), thrown));
  assert.deepEqual([b.verdict, findings(b), b.errors], ['VIOLATION', ['unexpected_tool_commit@3'], []]);
  assert.ok(b.incomplete.includes('authority unknown at step 3'));
  // (c) a receipt without a state change (a case with no delivery after the commit)
  const noWrite = editProbes(obsOf('commit-shift-across-cut'), 0, s => { s.managed = s.managed.filter(m => m.key !== 'ace:e1#1'); });
  const c = ev('commit-shift-across-cut', rereport(caseOf('commit-shift-across-cut'), noWrite));
  assert.deepEqual([c.verdict, findings(c), c.errors], ['VIOLATION', ['missing_tool_commit@1'], []]);
  // (d) a tool invocation followed by a rejected public promise
  const rejected = obsOf('session-isolation'); Object.assign(rejected.calls.find(x => x.step === 2)!, { outcome: 'rejected', class: 'AuthorityRevokedError' });
  const d = ev('session-isolation', rereport(caseOf('session-isolation'), rejected));
  assert.deepEqual([d.verdict, findings(d), d.errors], ['VIOLATION', ['false_deny@2'], []]);
});

test('partial runs keep confirmed findings: VIOLATION with incomplete, HARNESS_ERROR with findings, UNASSESSABLE without; all exit 2', () => {
  const id = 'start-before-cut';
  const truncate = (o: RuntimeObservation, last: number) => { const x = clone(o); x.probes = x.probes.filter(p => p.step <= last); x.calls = x.calls.filter(c => c.step <= last); x.complete = false; return x; };
  const violating = editProbes(obsOf(id), probeIndex(obsOf(id), 2, 'barrier_complete'), s => writeCommit(s, 'e1', 1));
  const v = ev(id, rereport(caseOf(id), truncate(violating, 2)));
  assert.equal(v.verdict, 'VIOLATION'); assert.equal(v.confirmed_violation, true); assert.ok(v.incomplete.includes('observation window not sealed'));
  const withError = rereport(caseOf(id), truncate(violating, 2)); withError.effects.push({ step: 2, kind: 'tool_commit', authority: 'a', execution: 'e1', target: null, seq: 0, provenance: ['sut_state'] });
  const h = ev(id, withError);
  assert.equal(h.verdict, 'HARNESS_ERROR'); assert.equal(h.confirmed_violation, true); assert.ok(h.incomplete.length > 0);
  const u = ev(id, rereport(caseOf(id), truncate(obsOf(id), 1)));
  assert.equal(u.verdict, 'UNASSESSABLE'); assert.equal(u.confirmed_violation, false);
  for (const [e, confirmed] of [[v, true], [h, true], [u, false]] as const) {
    const r = reportWith(new Map([[id, e]]));
    assert.equal(r.technically_valid, false); assert.equal(r.has_confirmed_violation, confirmed); assert.equal(profileExitCode(r), 2);
  }
});

test('ordering within a step: S4 under a premature terminal is a causally ordered VIOLATION; equal seq blocks only the order inference', () => {
  const id = 'sup-unobservable-pending-settlement';
  const base = obsOf(id);
  const terminalFrom = (o: RuntimeObservation, k: number) => editProbes(o, k, s => markTerminal(s, 'e1'));
  const firstEvent = base.probes.findIndex(p => p.step === 0 && p.point === 'event');
  const entry = probeIndex(base, 0, 'tool_entry');
  assert.ok(entry >= 0 && firstEvent > entry);
  // start at the entry probe, terminal first seen at the later event probe of the same step
  const m11 = ev(id, rereport(caseOf(id), terminalFrom(base, firstEvent)));
  assert.deepEqual([m11.verdict, findings(m11), m11.incomplete, m11.errors], ['VIOLATION', ['unexpected_execution_terminal@0'], ['terminal evidence missing for e1 in window 1..2'], []]);
  const r = reportWith(new Map([[id, m11]]));
  assert.equal(r.supplement_acceptance_passed, false); assert.equal(r.technically_valid, true); assert.equal(profileExitCode(r), 1);
  // without seq the 0.3.0 step-only path rejects the same trace as causally impossible
  const plain = rereport(caseOf(id), terminalFrom(base, firstEvent));
  const stepOnly = evaluate(caseOf(id), truthOf(id), { case_id: id, complete: true, decisions: plain.decisions.map(d => ({ step: d.step, decision: d.decision })).concat([{ step: 1, decision: 'ALLOW' }, { step: 2, decision: 'ALLOW' }]), effects: plain.effects.map(({ seq: _s, provenance: _p, ...f }) => f) });
  assert.deepEqual(stepOnly.errors.map(x => x.code), ['causally_impossible']);
  // equal seq: the order is not established (incompleteness), but the step-based finding is kept
  const same = ev(id, rereport(caseOf(id), terminalFrom(base, entry)));
  assert.equal(same.verdict, 'VIOLATION'); assert.deepEqual(findings(same), ['unexpected_execution_terminal@0']); assert.deepEqual(same.errors, []);
  assert.ok(same.incomplete.some(x => x.startsWith('effect order not established at step 0')));
  // reversed: a terminal observed before the start in the same step is causally impossible
  const reversed = clone(base);
  reversed.probes[entry].state.entries = [];
  for (const p of reversed.probes.slice(entry)) markTerminal(p.state, 'e1');
  const rev = ev(id, rereport(caseOf(id), reversed));
  assert.ok(rev.errors.some(x => x.code === 'causally_impossible'), JSON.stringify(rev.errors));
});

test('seq validation: a reported seq must be the first presence in the probe log; a broken log is sequence_inconsistent', () => {
  const id = 'in-flight-before-commit';
  const shifted = obsOf(id); shifted.effects.find(f => f.kind === 'execution_started')!.seq += 1;
  assert.ok(ev(id, shifted).errors.some(x => x.code === 'sequence_inconsistent'));
  const early = obsOf(id); early.effects.find(f => f.kind === 'cancellation_ack')!.seq -= 1;
  assert.ok(ev(id, early).errors.some(x => x.code === 'sequence_inconsistent'));
  const broken = obsOf(id); broken.probes[3].index = 99;
  const b = ev(id, broken);
  assert.ok(b.errors.some(x => x.code === 'sequence_inconsistent' && x.path === '/probes'));
  const dropped = obsOf(id); dropped.effects = dropped.effects.filter(f => f.kind !== 'execution_terminal');
  assert.ok(ev(id, dropped).errors.some(x => x.code === 'effect_not_reported'));
});

test('no back-filling and no control decisions: decisions must be the recorded SUT answers; finish/seal decisions are rejected', () => {
  const id = 'start-before-cut';
  const filled = obsOf(id); filled.decisions.find(d => d.step === 2)!.decision = 'ALLOW';
  assert.ok(ev(id, filled).errors.some(x => x.code === 'decision_without_evidence'));
  const control = obsOf(id); control.decisions.push({ step: 3, decision: 'ALLOW', provenance: ['sut_api'] });
  assert.ok(ev(id, control).errors.some(x => x.code === 'decision_at_control_step'));
  const drift = editProbes(obsOf('commit-before-cut'), 0, () => undefined);
  const del = probeIndex(drift, 3, 'pre_action');
  for (const p of drift.probes.slice(0, del)) p.state.deliveries = [];
  const d = ev('commit-before-cut', rereport(caseOf('commit-before-cut'), drift));
  assert.notEqual(d.verdict, 'PASS'); assert.ok(d.incomplete.some(x => x.startsWith('effect observed outside a step barrier')));
});

test('0.3.0 step path unchanged: the synthetic self-test reproduces the 0.3.0 observations and evidence byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-compat-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'dist/src/revocation-cli.js'), 'self-test', '--out', join(dir, 'o')], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const files = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]);
    const sel = files(join(dir, 'o')).map(f => relative(join(dir, 'o'), f)).filter(f => f.endsWith('evidence.jsonl') || f.endsWith('observations.json')).sort();
    const h = createHash('sha256');
    for (const f of sel) { h.update(f + '\n'); h.update(readFileSync(join(dir, 'o', f))); }
    assert.equal(sel.length, 32);
    // Hash of the same 32 files produced by revocation-0.3.0 (main at 7cc09ca) before this change.
    assert.equal(h.digest('hex'), '405fbe6a8ec468c943bbf428df6d9915d0d7f7263d2ae97bd3fc249cd6a9026c');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI run-adapter fails closed before any runtime: wrong profile binding, missing options', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'dist/src/revocation-cli.js'), ...args], { cwd: root, encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'rev-cli-'));
  try {
    const wrong = run('run-adapter', '--lock', LOCK, '--profile', 'profiles/revocation/acs-guardrail-demo-a682e44.supplement.json', '--out', join(dir, 'x'));
    assert.equal(wrong.status, 2); assert.match(wrong.stderr, /not the profile bound by the lock/);
    assert.equal(run('run-adapter', '--lock', LOCK, '--out', join(dir, 'y')).status, 2);
    assert.equal(run('mutants', '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'z'), '--only', 'M99').status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const firstTerminalProbe = (o: RuntimeObservation, label: string) => o.probes.findIndex(p => p.state.executions.some(x => x.label === label && x.state === 'terminal'));
const firstCommitProbe = (o: RuntimeObservation, key: string) => o.probes.findIndex(p => p.state.managed.some(m => m.key === key));
const inconsistent = (e: Evidence, text: string) => e.incomplete.some(x => x.startsWith('inconsistent state evidence') && x.includes(text));

test('terminal evidence: state terminal without the snapshot record is incomplete, never PASS; other findings stay', () => {
  const id = 'start-before-cut';
  const base = obsOf(id);
  const noRecord = editProbes(base, firstTerminalProbe(base, 'e1'), s => { for (const x of s.executions) x.terminal = null; });
  const e = ev(id, rereport(caseOf(id), noRecord));
  assert.equal(e.verdict, 'UNASSESSABLE'); assert.deepEqual(e.errors, []); assert.ok(inconsistent(e, 'no terminal record in the snapshot'), JSON.stringify(e.incomplete));
  // A violating commit in the same case stays a confirmed finding.
  const withCommit = editProbes(noRecord, probeIndex(noRecord, 2, 'barrier_complete'), s => writeCommit(s, 'e1', 1));
  const v = ev(id, rereport(caseOf(id), withCommit));
  assert.equal(v.verdict, 'VIOLATION'); assert.deepEqual(findings(v), ['unexpected_tool_commit@2']); assert.ok(inconsistent(v, 'no terminal record'));
});

test('terminal evidence: state terminal without its terminals() entry is incomplete, never PASS', () => {
  const id = 'start-before-cut';
  const base = obsOf(id);
  const e = ev(id, rereport(caseOf(id), editProbes(base, 0, s => { s.terminals = []; })));
  assert.equal(e.verdict, 'UNASSESSABLE'); assert.deepEqual(e.errors, []); assert.ok(inconsistent(e, '0 entries in terminals()'), JSON.stringify(e.incomplete));
});

test('terminal evidence: a record or terminal-log entry bound to another execution is incomplete, never PASS', () => {
  const id = 'session-in-flight-commit-fence';
  const base = obsOf(id);
  const other = (s: RuntimeObservation['probes'][number]['state'], label: string) => s.executions.find(x => x.label !== label)!.execution_id;
  const wrongRecord = editProbes(base, firstTerminalProbe(base, 'e1'), s => { const x = s.executions.find(y => y.label === 'e1')!; x.terminal = { execution_id: other(s, 'e1'), outcome: 'completed' }; });
  const a = ev(id, rereport(caseOf(id), wrongRecord));
  assert.notEqual(a.verdict, 'PASS'); assert.deepEqual(a.errors, []); assert.ok(inconsistent(a, "terminal record names"), JSON.stringify(a.incomplete));
  const wrongLog = editProbes(base, firstTerminalProbe(base, 'e1'), s => { const x = s.executions.find(y => y.label === 'e1')!; s.terminals = s.terminals.map(t => (t.execution_id === x.execution_id ? { ...t, execution_id: 'exec-999' } : t)); });
  const b = ev(id, rereport(caseOf(id), wrongLog));
  assert.notEqual(b.verdict, 'PASS'); assert.deepEqual(b.errors, []); assert.ok(inconsistent(b, 'exec-999'), JSON.stringify(b.incomplete));
});

test('commit evidence: a key without its written value, with another value, or without version growth is incomplete, never PASS', () => {
  const id = 'commit-before-cut';
  const base = obsOf(id);
  const from = firstCommitProbe(base, 'ace:e1#1');
  for (const [name, edit, text] of [
    ['undefined value', (s: RuntimeObservation['probes'][number]['state']) => { for (const m of s.managed) m.value_json = null; }, 'get(key) returned undefined'],
    ['other value', (s: RuntimeObservation['probes'][number]['state']) => { for (const m of s.managed) m.value_json = '{"x":1}'; }, 'not the written value'],
    ['no version growth', (s: RuntimeObservation['probes'][number]['state']) => { s.managed_version = 0; }, 'managed_version 0 -> 0'],
  ] as const) {
    const e = ev(id, rereport(caseOf(id), editProbes(base, name === 'no version growth' ? 0 : from, edit)));
    assert.notEqual(e.verdict, 'PASS', name); assert.deepEqual(e.errors, [], name); assert.ok(inconsistent(e, text), `${name}: ${JSON.stringify(e.incomplete)}`);
    assert.ok(!e.effect_findings.some(f => f.reason === 'missing_tool_commit'), `${name}: contradictory evidence is not a missing commit`);
  }
});

test('commit evidence: an API receipt or exception neither replaces nor removes the state observation', () => {
  // A denied commit (CommitRejectedError) with a complete state write is a confirmed effect violation.
  const id = 'in-flight-before-commit';
  const base = obsOf(id);
  const full = ev(id, rereport(caseOf(id), editProbes(base, probeIndex(base, 3, 'barrier_complete'), s => writeCommit(s, 'e1', 1))));
  assert.deepEqual([full.verdict, findings(full)], ['VIOLATION', ['unexpected_tool_commit@3']]);
  // The same denial with only a key (no value) is contradictory evidence: incomplete, not hidden and not PASS.
  const partial = ev(id, rereport(caseOf(id), editProbes(base, probeIndex(base, 3, 'barrier_complete'), s => { s.managed.push({ key: 'ace:e1#1', label: 'e1', n: 1, value_json: null }); })));
  assert.notEqual(partial.verdict, 'PASS'); assert.deepEqual(partial.errors, []); assert.ok(inconsistent(partial, 'ace:e1#1'));
  // An allowed commit (receipt) whose state shows no write is a missing effect, not a PASS.
  const noState = editProbes(obsOf('commit-shift-across-cut'), 0, s => { s.managed = []; s.managed_version = 0; });
  const r = ev('commit-shift-across-cut', rereport(caseOf('commit-shift-across-cut'), noState));
  assert.deepEqual([r.verdict, findings(r)], ['VIOLATION', ['missing_tool_commit@1']]);
});

type State = RuntimeObservation['probes'][number]['state'];
const noTerminalRecord = (label: string) => (s: State) => { for (const x of s.executions) if (x.label === label) x.terminal = null; };
const keyWithoutValue = (label: string) => (s: State) => { for (const m of s.managed) if (m.label === label) m.value_json = null; };

test('scoped evidence gaps: a missing commit stays a confirmed finding beside an unrelated terminal contradiction (exit 2)', () => {
  const id = 'commit-shift-across-cut';
  const noCommit = editProbes(obsOf(id), 0, s => { s.managed = []; s.managed_version = 0; });
  // 1. The missing commit alone.
  const alone = ev(id, rereport(caseOf(id), noCommit));
  assert.deepEqual([alone.verdict, findings(alone), alone.errors], ['VIOLATION', ['missing_tool_commit@1'], []]);
  // 2. The same missing commit with contradictory terminal evidence of the execution: same finding, plus incomplete.
  const both = ev(id, rereport(caseOf(id), editProbes(noCommit, firstTerminalProbe(noCommit, 'e1'), noTerminalRecord('e1'))));
  assert.deepEqual([both.verdict, findings(both), both.errors, both.confirmed_violation], ['VIOLATION', ['missing_tool_commit@1'], [], true]);
  assert.ok(inconsistent(both, 'term:e1: state terminal, but no terminal record'), JSON.stringify(both.incomplete));
  assert.ok(both.incomplete.includes('expected effect not confirmed: e1 in window 2..5'), JSON.stringify(both.incomplete));
  const r = reportWith(new Map([[id, both]]));
  assert.deepEqual([r.technically_valid, r.has_confirmed_violation, profileExitCode(r)], [false, true, 2]);
});

test('scoped evidence gaps: one execution\'s contradictory evidence never removes another execution\'s confirmed findings', () => {
  const id = 'session-in-flight-commit-fence';
  // e2 (session s2, not revoked) neither commits nor delivers in the state: two confirmed missing effects.
  const e2Missing = editProbes(obsOf(id), 0, s => { s.managed = s.managed.filter(m => m.label !== 'e2'); s.deliveries = s.deliveries.filter(d => d.label !== 'e2'); });
  const plain = ev(id, rereport(caseOf(id), e2Missing));
  assert.deepEqual([plain.verdict, findings(plain)], ['VIOLATION', ['missing_output_delivery@5', 'missing_tool_commit@4']]);
  // e1 (revoked session) with contradictory terminal evidence, or with a denied commit whose state is contradictory.
  const e1Commit = editProbes(e2Missing, probeIndex(e2Missing, 3, 'barrier_complete'), s => writeCommit(s, 'e1', 1));
  for (const [name, o, text] of [
    ['e1 terminal record missing', editProbes(e2Missing, firstTerminalProbe(e2Missing, 'e1'), noTerminalRecord('e1')), 'term:e1'],
    ['e1 commit key without value', editProbes(e1Commit, probeIndex(e1Commit, 3, 'barrier_complete'), keyWithoutValue('e1')), 'commit:ace:e1#1'],
  ] as const) {
    const e = ev(id, rereport(caseOf(id), o));
    assert.deepEqual([e.verdict, findings(e), e.errors, e.confirmed_violation], ['VIOLATION', ['missing_output_delivery@5', 'missing_tool_commit@4'], [], true], name);
    assert.ok(inconsistent(e, text), `${name}: ${JSON.stringify(e.incomplete)}`);
  }
});

test('scoped evidence gaps: contradictory commit evidence still leaves that commit unconfirmed and blocks PASS', () => {
  // The expected commit of commit-shift-across-cut (step 1) listed without its written value: neither PASS nor missing.
  const id = 'commit-shift-across-cut';
  const base = obsOf(id);
  const e = ev(id, rereport(caseOf(id), editProbes(base, firstCommitProbe(base, 'ace:e1#1'), keyWithoutValue('e1'))));
  assert.deepEqual([e.verdict, findings(e), e.errors, e.confirmed_violation], ['UNASSESSABLE', [], [], false]);
  assert.ok(inconsistent(e, 'commit:ace:e1#1: key listed but get(key) returned undefined'), JSON.stringify(e.incomplete));
  assert.ok(e.incomplete.includes('expected effect not confirmed: tool_commit at step 1'), JSON.stringify(e.incomplete));
  // Without version growth, likewise.
  const v = ev(id, rereport(caseOf(id), editProbes(base, 0, s => { s.managed_version = 0; })));
  assert.deepEqual([v.verdict, findings(v)], ['UNASSESSABLE', []]);
  assert.ok(v.incomplete.includes('expected effect not confirmed: tool_commit at step 1'), JSON.stringify(v.incomplete));
  // A contradiction is bounded by its window: a contradictory write-behind commit after the cut does not confirm the
  // commit expected at step 1, which stays missing; the late write itself stays unconfirmed (incomplete).
  const late = editProbes(editProbes(base, 0, s => { s.managed = []; s.managed_version = 0; }), probeIndex(base, 3, 'barrier_complete'), s => s.managed.push({ key: 'ace:e1#1', label: 'e1', n: 1, value_json: null }));
  const l = ev(id, rereport(caseOf(id), late));
  assert.deepEqual([l.verdict, findings(l), l.confirmed_violation], ['VIOLATION', ['missing_tool_commit@1'], true]);
  assert.ok(inconsistent(l, 'commit:ace:e1#1'), JSON.stringify(l.incomplete));
});

const cliRun = (...args: string[]) => spawnSync(process.execPath, [join(root, 'dist/src/revocation-cli.js'), ...args], { cwd: root, encoding: 'utf8' });
const FIXTURE = join(root, 'test/fixtures/revocation-runtime/a682e44-baseline-observations.json');
const evaluateRecorded = (input: string, out: string) => cliRun('evaluate', '--observations', input, '--lock', LOCK, '--profile', lock.profile, '--out', out);

test('evaluate --observations --profile --lock: the recorded baseline gives the same evidence, acceptance fields and exit 3 without the SUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-recorded-'));
  try {
    const r = evaluateRecorded(FIXTURE, join(dir, 'o'));
    assert.equal(r.status, 3, r.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'o/report.json'), 'utf8'));
    assert.deepEqual(validateProfileReport(report), []);
    assert.equal(report.observation_source, 'recorded_runtime_adapter_observations');
    assert.equal(report.sut.build_sha256, null);
    const expectedReport = reportWith();
    assert.equal(canonicalJsonLines(report.evidence), canonicalJsonLines(expectedReport.evidence));
    assert.equal(canonicalJsonLines(report.supplement.cases), canonicalJsonLines(expectedReport.supplement.cases));
    for (const k of ['counts', 'technically_valid', 'has_confirmed_violation', 'contract_acceptance_passed', 'profile_acceptance_passed', 'supplement_acceptance_passed'] as const) assert.deepEqual(report[k], expectedReport[k], k);
    assert.equal(readFileSync(join(dir, 'o/observations.json'), 'utf8'), readFileSync(FIXTURE, 'utf8'));
    const manifest = JSON.parse(readFileSync(join(dir, 'o/manifest.json'), 'utf8'));
    assert.equal(manifest.input_observations_sha256, sha256Hex(readFileSync(FIXTURE)));
    // The same evaluation path accepts any case order.
    const shuffled = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    shuffled.corpus.reverse(); shuffled.supplement.reverse();
    writeFileSync(join(dir, 'shuffled.json'), JSON.stringify(shuffled));
    assert.equal(evaluateRecorded(join(dir, 'shuffled.json'), join(dir, 's')).status, 3);
    assert.equal(readFileSync(join(dir, 's/evidence.jsonl'), 'utf8'), readFileSync(join(dir, 'o/evidence.jsonl'), 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evaluate --observations --profile --lock: invalid recorded input fails closed with exit 2 and no report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-recorded-bad-'));
  try {
    const base = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as { corpus: { case_id: string }[]; supplement: { case_id: string }[]; [k: string]: unknown };
    const cases_: [string, string | ((o: ReturnType<typeof base>) => unknown), RegExp][] = [
      ['not json', '{', /not valid JSON/],
      ['array', '[]', /must be an object/],
      ['missing supplement', o => { delete (o as Record<string, unknown>).supplement; return o; }, /exactly the fields/],
      ['extra field', o => ({ ...o, extra: [] }), /exactly the fields/],
      ['out-of-scope case', o => { o.corpus.push({ ...o.corpus[0], case_id: 'permit-single-use' }); return o; }, /OUT_OF_SCOPE case permit-single-use/],
      ['missing in-profile case', o => { o.corpus.pop(); return o; }, /one corpus observation per IN_PROFILE case/],
      ['duplicate case', o => { o.corpus[1] = o.corpus[0]; return o; }, /one corpus observation per IN_PROFILE case/],
      ['unknown supplement case', o => { o.supplement[0] = { ...o.supplement[0], case_id: 'sup-unknown' }; return o; }, /one observation per supplement case/],
      ['item without case_id', o => { o.supplement[0] = {} as { case_id: string }; return o; }, /has no case_id/],
    ];
    cases_.forEach(([name, make, message], i) => {
      const file = join(dir, `in-${i}.json`);
      writeFileSync(file, typeof make === 'string' ? make : JSON.stringify(make(base())));
      const r = evaluateRecorded(file, join(dir, `out-${i}`));
      assert.equal(r.status, 2, name); assert.match(r.stderr, message, name);
      assert.throws(() => statSync(join(dir, `out-${i}`)), name);
    });
    const wrongProfile = cliRun('evaluate', '--observations', FIXTURE, '--lock', LOCK, '--profile', lock.supplement, '--out', join(dir, 'wp'));
    assert.equal(wrongProfile.status, 2); assert.match(wrongProfile.stderr, /not the profile bound by the lock/);
    assert.equal(cliRun('evaluate', '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'no-obs')).status, 2);
    // A schema-invalid observation is evaluated as a HARNESS_ERROR of that case (report written, exit 2).
    const broken = base(); delete (broken.corpus[0] as Record<string, unknown>).probes;
    writeFileSync(join(dir, 'broken.json'), JSON.stringify(broken));
    const r = evaluateRecorded(join(dir, 'broken.json'), join(dir, 'broken-out'));
    assert.equal(r.status, 2);
    const report = JSON.parse(readFileSync(join(dir, 'broken-out/report.json'), 'utf8'));
    assert.equal(report.evidence.find((e: { case_id: string }) => e.case_id === broken.corpus[0].case_id).verdict, 'HARNESS_ERROR');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evaluate --observations: a scoped evidence gap keeps the recorded finding (exit 2, has_confirmed_violation) on the CLI path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-recorded-gap-'));
  try {
    const id = 'commit-shift-across-cut';
    const noCommit = editProbes(obsOf(id), 0, s => { s.managed = []; s.managed_version = 0; });
    const scenarios = [
      ['missing commit + terminal contradiction', rereport(caseOf(id), editProbes(noCommit, firstTerminalProbe(noCommit, 'e1'), noTerminalRecord('e1'))), 'VIOLATION', ['missing_tool_commit@1'], true],
      ['contradictory expected commit', rereport(caseOf(id), editProbes(obsOf(id), firstCommitProbe(obsOf(id), 'ace:e1#1'), keyWithoutValue('e1'))), 'UNASSESSABLE', [], false],
    ] as const;
    scenarios.forEach(([name, o, verdict, expectedFindings, confirmed], i) => {
      const recorded = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { corpus: RuntimeObservation[] };
      recorded.corpus = recorded.corpus.map(x => (x.case_id === id ? o : x));
      writeFileSync(join(dir, `in-${i}.json`), JSON.stringify(recorded));
      const r = evaluateRecorded(join(dir, `in-${i}.json`), join(dir, `out-${i}`));
      assert.equal(r.status, 2, `${name}: ${r.stderr}`);
      const report = JSON.parse(readFileSync(join(dir, `out-${i}/report.json`), 'utf8'));
      assert.deepEqual(validateProfileReport(report), [], name);
      const e = report.evidence.find((x: Evidence) => x.case_id === id) as Evidence;
      assert.deepEqual([e.verdict, findings(e), e.confirmed_violation, report.has_confirmed_violation, report.technically_valid], [verdict, expectedFindings, confirmed, confirmed, false], name);
      assert.equal(canonicalJsonLines(report.evidence), canonicalJsonLines(reportWith(new Map([[id, ev(id, o)]])).evidence), `${name}: the CLI evidence equals the in-process evaluation`);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
