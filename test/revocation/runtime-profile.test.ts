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
import { editProbes, probeIndex, rereport } from '../../src/mutation/revocation/adapter-mutants';
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
    corpus: cases, truths: cases.map(expected), corpus_sha256: corpusSha, profile: prof, profile_sha256: profileSha, supplement_id: supplement.supplement, supplement_sha256: supplementSha,
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
  const write = (o: RuntimeObservation, step: number) => editProbes(o, probeIndex(o, step, 'barrier_complete'), s => { s.managed.push({ key: 'ace:e1#1', label: 'e1', n: 1 }); });
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
  const violating = editProbes(obsOf(id), probeIndex(obsOf(id), 2, 'barrier_complete'), s => { s.managed.push({ key: 'ace:e1#1', label: 'e1', n: 1 }); });
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
  const terminalFrom = (o: RuntimeObservation, k: number) => editProbes(o, k, s => { for (const x of s.executions) if (x.label === 'e1') x.state = 'terminal'; });
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
  reversed.probes[entry].state.entries = []; reversed.probes[entry].state.executions = [{ label: 'e1', execution_id: 'exec-1', capability_id: Object.keys(base.identity.capabilities)[0], session_id: Object.keys(base.identity.sessions)[0], state: 'terminal', cancellation_acknowledged: false }];
  for (const p of reversed.probes.slice(entry + 1)) for (const x of p.state.executions) x.state = 'terminal';
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
