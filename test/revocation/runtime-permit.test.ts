/**
 * revocation-0.4.0 declared-profile tests of the current pin (acs-guardrail-demo@ef775db, v0.6.0, tenancy mode with
 * the approval-permit lifecycle in permit mode, runtime observation format 3) that need no SUT: they evaluate the
 * committed observations of that runtime's baseline run (test/fixtures/revocation-runtime/ef775db-baseline-observations.json,
 * byte-compared against a fresh run in runtime-sut.test.ts) and controlled edits of them that simulate adapter or SUT
 * behaviour the baseline does not show (approval-permit lifecycle plan sections 7.1, 7.6 and 8.3). The format 2 path
 * of the a9deab6 pin stays covered by runtime-tenancy.test.ts, the format 1 path of the a682e44 pin by
 * runtime-profile.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cases, root } from './helpers';
import { expected } from '../../src/oracle/revocation/expected';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { Case, CallRecord, Evidence, RuntimeObservation, VERSION } from '../../src/spec/revocation/model';
import { classify, rulesOf } from '../../src/profile/revocation/classifier';
import { controlSteps, loadProfile, loadSupplement } from '../../src/profile/revocation/profile';
import { buildProfileReport, profileExitCode } from '../../src/report/revocation/profile-report';
import { runtimeObservationIssues, validateProfileReport } from '../../src/report/revocation/validate';
import { identityFor } from '../../src/adapter/revocation-runtime/runner';
import { editProbes, probeIndex, rereport } from '../../src/mutation/revocation/adapter-mutants';
import { decisionFromCall, derive, lifecycleTransitions } from '../../src/spec/revocation/runtime-observation';
import { evidenceKindIssues } from '../../src/eval/revocation/runtime-gates';
import { loadRevocationLock, RevocationLockError } from '../../src/sut/revocation-lock';
import { classifyMaskedRun, classifyMutantRun, loadMutantManifest, MUTANT_MANIFEST, MutantManifestError, RevocationMutant, RunFacts, unexpectedTechnical, witnessParts } from '../../src/mutation/revocation/mutants';
import { canonicalJsonLines } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';

const LOCK = 'sut.revocation.lock.json';
const { lock, sha256: lockSha256 } = loadRevocationLock(join(root, LOCK), VERSION);
const corpusSha = sha256Hex(canonicalJsonLines(cases));
const { profile, sha256: profileSha } = loadProfile(root, lock.profile, cases, corpusSha, VERSION, lock.sut_commit);
const { supplement, sha256: supplementSha } = loadSupplement(root, lock.supplement, VERSION, lock.sut_commit);
const FIXTURE = join(root, 'test/fixtures/revocation-runtime/ef775db-baseline-observations.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { corpus: RuntimeObservation[]; supplement: RuntimeObservation[] };
const HISTORY = 'profiles/revocation/history/sut.revocation.a9deab6.lock.json';
const historyLock = loadRevocationLock(join(root, HISTORY), VERSION).lock;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const caseOf = (id: string): Case => cases.find(c => c.id === id) ?? (() => { const s = supplement.cases.find(x => x.id === id)!; return { id: s.id, family: s.family, authorities: s.authorities, steps: s.steps }; })();
const truthOf = (id: string) => supplement.cases.find(x => x.id === id)?.expected ?? expected(caseOf(id));
const obsOf = (id: string) => clone([...fixture.corpus, ...fixture.supplement].find(o => o.case_id === id)!);
const ev = (id: string, o: unknown, format: 1 | 2 | 3 = 3) => evaluate(caseOf(id), truthOf(id), o, { ordering: 'probe_seq', controlSteps: controlSteps(caseOf(id)), observationFormat: format });
const codes = (e: Evidence) => [...new Set(e.errors.map(x => x.code))].sort();
const findings = (e: Evidence) => [...e.decision_findings, ...e.effect_findings].map(f => `${f.reason}@${f.step}`).sort();
const cliRun = (...args: string[]) => spawnSync(process.execPath, [join(root, 'dist/src/revocation-cli.js'), ...args], { cwd: root, encoding: 'utf8' });
const lifecycleEffects = (o: RuntimeObservation) => o.effects.filter(f => f.kind === 'approval_granted' || f.kind === 'permit_issued').map(f => `${f.kind}@${f.step}:${f.authority}`);

function reportWith(over: Map<string, Evidence> = new Map()) {
  const evidence = new Map<string, Evidence>();
  for (const o of fixture.corpus) evidence.set(o.case_id, ev(o.case_id, o));
  for (const [id, e] of over) if (cases.some(c => c.id === id)) evidence.set(id, e);
  const supp = supplement.cases.map(c => ({ c, e: over.get(c.id) ?? ev(c.id, obsOf(c.id)) }));
  return buildProfileReport({
    corpus: cases, truths: cases.map(expected), corpus_sha256: corpusSha, observation_source: 'pinned_runtime_adapter', profile, profile_sha256: profileSha, supplement_id: supplement.supplement, supplement_sha256: supplementSha,
    evidence, supplement: supp,
    sut: { repository: lock.sut_repository, commit: lock.sut_commit, tree: lock.sut_tree, version: lock.sut_version, lock_sha256: lockSha256, build_sha256: '0'.repeat(64), baseline_verified: false },
    harness_commit: null, harness_worktree_clean: false,
  });
}

const MOVED = ['pending-approval', 'issue-after-cut', 'fresh-id-retry-unused-permit', 'derived-authority', 'permit-single-use', 'approval-before-cut'];
const LIFECYCLE = ['initial_pending_authority', 'approve', 'issue', 'single_use_permit'];

test('pin: v0.6.0 at ef775db in tenancy and permit mode, tag and content hashes bound, ACS pin and earlier pins unchanged', () => {
  assert.equal(lock.sut_commit, 'ef775dbff6c5691b4b2d44611b22eb33c431f451');
  assert.equal(lock.sut_tree, '7eb9f3368df5c83d6fb65c79ca867df0bf19e41c');
  assert.equal(lock.sut_version, '0.6.0');
  assert.deepEqual(lock.sut_tag, { name: 'v0.6.0', object: 'c83cd669d3b7bdea203d368102cb266e669f7752' });
  assert.equal(lock.sut_package_lock_sha256, 'b8be539447e54a3cca6b2011df3cce7396f9f73a37ffb0cc6cc419fcd76b7c3d');
  assert.equal(lock.sut_runtime_mode, 'tenancy'); assert.equal(lock.sut_lifecycle_mode, 'permit'); assert.equal(lock.max_chain_length, 8);
  assert.deepEqual([lock.baseline_at_pin.test_suites, lock.baseline_at_pin.tests], [33, 774]);
  const g = lock.runtime_test_gates!;
  assert.equal(g.lifecycle!.manifest_sha256, '80952ae5ba267500860c09ce121649b4f96e28478d8a305982eb0b3d696e2298');
  assert.deepEqual(g.lifecycle!.counts, { manifest_entries: 26, distinct_patches: 20, mechanisms: 20, variants: 6, witness_tests: 41, control_witness_tests: 4 });
  assert.deepEqual(Object.keys(g.lifecycle_regressions!.cases).length, 24);
  assert.equal(g.lifecycle_determinism!.command, 'npm run mutants:lifecycle:determinism');
  // The tenant and ancestor gate manifests are those of the a9deab6 pin, byte for byte.
  assert.deepEqual([g.tenant, g.ancestor], [historyLock.runtime_test_gates!.tenant, historyLock.runtime_test_gates!.ancestor]);
  // Lifecycle and availability are their own evidence kinds, never containment.
  assert.deepEqual(g.lifecycle!.evidence.check_and_availability, ['M65']);
  assert.ok(!g.lifecycle!.evidence.both!.includes('M65'));
  assert.equal(JSON.parse(readFileSync(join(root, 'sut.lock.json'), 'utf8')).sut_commit, '403d31593a0d57187df3f5e1ef3df6127baaefb9');
  assert.equal(historyLock.sut_commit, 'a9deab6709d6ca2ba8f3988693b50fa807eadc0c');
  assert.equal(loadRevocationLock(join(root, 'profiles/revocation/history/sut.revocation.a682e44.lock.json'), VERSION).lock.sut_commit, 'a682e4479dbccd1cd5f665f5d4879bd3dddb8b47');
});

test('lock: permit mode, the lifecycle gate and its regressions fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-lock-permit-'));
  try {
    const good = JSON.parse(readFileSync(join(root, LOCK), 'utf8'));
    const gates = good.runtime_test_gates;
    const { lifecycle: _l, lifecycle_regressions: _r, lifecycle_determinism: _d, ...plain } = gates;
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['unknown lifecycle mode', { sut_lifecycle_mode: 'both' }, /neither legacy nor permit/],
      ['permit without tenancy', { sut_runtime_mode: 'legacy', max_chain_length: undefined }, /tenancy mode only/],
      ['permit without lifecycle gate', { runtime_test_gates: plain }, /pins the lifecycle gate/],
      ['legacy with lifecycle gate', { sut_lifecycle_mode: 'legacy' }, /permit mode only/],
      ['lifecycle kinds of the tenant gate', { runtime_test_gates: { ...gates, lifecycle: { ...gates.lifecycle, evidence: gates.tenant.evidence } } }, /exactly the kinds/],
      ['lifecycle mutant twice', { runtime_test_gates: { ...gates, lifecycle: { ...gates.lifecycle, evidence: { ...gates.lifecycle.evidence, check_and_availability: ['M65', 'M53'] } } } }, /exactly once/],
      ['lifecycle counts', { runtime_test_gates: { ...gates, lifecycle: { ...gates.lifecycle, counts: { manifest_entries: 'x' } } } }, /integer counts/],
      ['lifecycle variant unknown', { runtime_test_gates: { ...gates, lifecycle: { ...gates.lifecycle, variants: { M58: ['M58-x'] } } } }, /variants must name pinned entries/],
      ['beyond-kind unknown', { runtime_test_gates: { ...gates, lifecycle: { ...gates.lifecycle, observed_beyond_kind: ['M99'] } } }, /observed_beyond_kind/],
      ['lifecycle regression exits', { runtime_test_gates: { ...gates, lifecycle_regressions: { ...gates.lifecycle_regressions, cases: { 'RL1-detected': 'zero' } } } }, /lifecycle_regressions/],
      ['determinism command', { runtime_test_gates: { ...gates, lifecycle_determinism: { command: 'node x', expected_exit: 0 } } }, /lifecycle_determinism/],
    ];
    for (const [name, patch, message] of bad) {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify({ ...good, ...patch }));
      assert.throws(() => loadRevocationLock(join(dir, 'lock.json'), VERSION), (e: Error) => e instanceof RevocationLockError && message.test(e.message), name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('profile v4: 23 IN_PROFILE / 4 OUT_OF_SCOPE from the revoke scopes and the lifecycle rules; K = 57; 27 newly assessed decisions', () => {
  assert.equal(profile.observation_format, 3);
  assert.deepEqual((profile.supported as { lifecycle?: string[] }).lifecycle, LIFECYCLE);
  const rules = rulesOf(profile.supported.revoke.scopes, LIFECYCLE);
  const before = rulesOf(profile.supported.revoke.scopes);
  for (const c of cases) {
    const k = classify(c, expected(c), rules);
    const p = profile.cases.find(x => x.id === c.id)!;
    assert.deepEqual([k.applicability, k.not_assessed_requirements], [p.applicability, p.not_assessed_requirements], c.id);
    // Moved exactly the six cases of plan section 6, by the lifecycle rules alone.
    assert.equal(classify(c, expected(c), before).applicability !== k.applicability, MOVED.includes(c.id), c.id);
  }
  const inProfile = profile.cases.filter(c => c.applicability === 'IN_PROFILE');
  assert.equal(inProfile.length, 23);
  assert.deepEqual(profile.cases.filter(c => c.applicability === 'OUT_OF_SCOPE').map(c => [c.id, c.out_of_scope!.map(x => x.capability_class)]), [
    ['late-commit-after-terminal', ['deliver_after_finish']], ['retry-after-revocation', ['operation_on_execution_unknown_to_runtime']],
    ['cancel-is-not-rollback', ['deliver_after_finish']], ['execution-id-reuse', ['client_chosen_execution_id', 'operation_on_execution_unknown_to_runtime']],
  ]);
  assert.equal(inProfile.reduce((n, c) => n + c.not_assessed_requirements.length, 0), 57);
  const moved = profile.cases.filter(c => MOVED.includes(c.id));
  assert.deepEqual(moved.map(c => c.not_assessed_requirements.length), [2, 2, 3, 2, 3, 2]);
  // Plan section 6 (corrected from 28): approval-before-cut has 6 assessed decisions (steps 0-4 and the revoke at 6), its
  // step 5 is a finish (K). 41 decisions of the six cases minus K = 14.
  assert.deepEqual(moved.map(c => caseOf(c.id).steps.length - c.not_assessed_requirements.length), [4, 4, 5, 4, 4, 6]);
  assert.equal(moved.reduce((n, c) => n + caseOf(c.id).steps.length - c.not_assessed_requirements.length, 0), 27);
  // The permit caveats are gone: these authorities now start with a real, unused permit.
  for (const id of ['issued-permit', 'cut-before-start', 'duplicate-revocation']) assert.equal(profile.cases.find(c => c.id === id)!.family_caveat, undefined, id);
  assert.deepEqual(profile.uncovered_design_fences, ['execution identity (execution_id_in_use, unbound_execution)']);
  for (const k of LIFECYCLE) assert.ok(!(profile as unknown as { unsupported_classes: string[] }).unsupported_classes.includes(k), k);
  assert.equal(readFileSync(join(root, 'corpus/revocation/smoke.sha256'), 'utf8').trim(), corpusSha);
});

test('profile v4 fails closed: lifecycle rules need format 3 and vice versa; unknown lifecycle classes are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-profile-permit-'));
  try {
    const good = JSON.parse(readFileSync(join(root, lock.profile), 'utf8'));
    const write = (p: unknown) => { const text = JSON.stringify(p, null, 2) + '\n'; writeFileSync(join(dir, 'p.json'), text); writeFileSync(join(dir, 'p.sha256'), sha256Hex(text) + '\n'); };
    const load = () => loadProfile(dir, 'p.json', cases, corpusSha, VERSION, lock.sut_commit);
    write(good); assert.doesNotThrow(load);
    for (const [name, p, message] of [
      ['format 2 with lifecycle', { ...good, observation_format: 2 }, /exactly with observation_format 3/],
      ['format 3 without lifecycle', { ...good, supported: { ...good.supported, lifecycle: [] } }, /exactly with observation_format 3/],
      ['unknown class', { ...good, supported: { ...good.supported, lifecycle: [...LIFECYCLE, 'regrant'] } }, /unknown lifecycle capability class/],
      ['without single use', { ...good, supported: { ...good.supported, lifecycle: LIFECYCLE.slice(0, 3) } }, /differs from the classifier/],
    ] as [string, unknown, RegExp][]) { write(p); assert.throws(load, message, name); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supplement v3: S1-S14 hash-bound and oracle-checked; S3-S6, S9, S10 unchanged; S1, S2, S7, S8 re-mapped to approve, issue and start', () => {
  assert.equal(supplement.supplement, 'acs-guardrail-demo-ef775db/revocation-0.4.0/supplement/3');
  assert.deepEqual(supplement.cases.map(c => c.id), [
    'sup-pending-approval-revoked', 'sup-pending-approval-control', 'sup-commit-after-terminal-no-revocation', 'sup-unobservable-pending-settlement',
    'sup-ancestor-revoked-child-start', 'sup-ancestor-control', 'sup-tenant-pending-approval-revoked', 'sup-ancestor-pending-approval-revoked', 'sup-tenant-fences-in-flight', 'sup-ancestor-fences-in-flight',
    'sup-session-revoke-pending-approval', 'sup-tenant-revoke-unused-permit', 'sup-ancestor-revoke-unused-permit', 'sup-ancestor-revoke-approved-before-issue',
  ]);
  const old = loadSupplement(root, historyLock.supplement, VERSION, historyLock.sut_commit).supplement;
  for (const id of ['sup-commit-after-terminal-no-revocation', 'sup-unobservable-pending-settlement', 'sup-ancestor-revoked-child-start', 'sup-ancestor-control', 'sup-tenant-fences-in-flight', 'sup-ancestor-fences-in-flight']) {
    assert.deepEqual(supplement.cases.find(c => c.id === id), old.cases.find(c => c.id === id), id);
  }
  for (const id of ['sup-pending-approval-revoked', 'sup-pending-approval-control', 'sup-tenant-pending-approval-revoked', 'sup-ancestor-pending-approval-revoked']) {
    const c = supplement.cases.find(x => x.id === id)! as unknown as Record<string, unknown> & { steps: { op: string }[] };
    assert.ok(!('setup' in c) && !('approve_starts' in c), id);
    assert.deepEqual(c.steps.filter(s => ['approve', 'issue', 'start'].includes(s.op)).map(s => s.op), ['approve', 'issue', 'start'], id);
  }
  // Every case is the contract oracle's now; S2 no longer needs a runtime-specific expectation.
  for (const c of supplement.cases) assert.equal(c.expectation_source, 'contract_oracle', c.id);
  assert.deepEqual(truthOf('sup-pending-approval-control').effects.map(e => `${e.kind}@${e.earliest}`), ['approval_granted@0', 'permit_issued@1', 'execution_started@2', 'execution_terminal@3']);
  assert.deepEqual(truthOf('sup-ancestor-revoke-approved-before-issue').decisions.filter(d => d.step < 4).map(d => d.decision), ['ALLOW', 'ALLOW', 'DENY', 'DENY']);
  assert.equal(sha256Hex(readFileSync(join(root, lock.supplement))), readFileSync(join(root, lock.supplement.replace(/\.json$/, '.sha256')), 'utf8').trim());
});

test('baseline: 23/23 PASS, supplement S1-S14 as declared, K = 57, exit 3, never a contract pass', () => {
  const r = reportWith();
  assert.deepEqual(validateProfileReport(r), []);
  assert.deepEqual([r.counts.PASS, r.counts.in_profile, r.counts.out_of_scope, r.counts.corpus_total, r.counts.not_assessed_requirements], [23, 23, 4, 27, 57]);
  for (const e of r.evidence.filter(x => x.applicability === 'OUT_OF_SCOPE')) assert.equal(e.verdict, null);
  assert.deepEqual(r.supplement.cases.map(s => [s.case_id, s.evidence.verdict, s.matches_declaration]), supplement.cases.map(c => [c.id, c.id === 'sup-unobservable-pending-settlement' ? 'UNASSESSABLE' : 'PASS', true]));
  assert.equal(r.contract_acceptance_passed, false); assert.equal(r.profile_acceptance_passed, true); assert.equal(r.supplement_acceptance_passed, true);
  assert.equal(r.technically_valid, true); assert.equal(profileExitCode(r), 3);
  for (const o of [...fixture.corpus, ...fixture.supplement]) {
    assert.deepEqual(runtimeObservationIssues(o), [], o.case_id);
    assert.deepEqual(o.identity, (() => { const i = identityFor(caseOf(o.case_id)); i.lineages = o.identity.lineages; return i; })(), o.case_id);
  }
});

test('evidence: the setup baseline is the first probe; lifecycle effects are post-baseline transitions of the runtime state', () => {
  for (const o of [...fixture.corpus, ...fixture.supplement]) {
    const c = caseOf(o.case_id);
    assert.equal(o.probes[0].point, 'setup_baseline', o.case_id);
    assert.equal(o.probes.filter(p => p.point === 'setup_baseline').length, 1, o.case_id);
    assert.deepEqual(Object.values(o.identity.lineages!).sort(), c.authorities.map(a => a.id).sort(), o.case_id);
    for (const l of o.probes[0].state.lineages!) assert.equal(l.state, c.authorities.find(a => a.id === o.identity.lineages![l.lineage_id])!.initial, `${o.case_id} ${l.lineage_id}`);
    // Every lifecycle effect has sut_state provenance and is exactly the derivation's.
    for (const f of o.effects.filter(x => x.kind === 'approval_granted' || x.kind === 'permit_issued')) assert.deepEqual(f.provenance, ['sut_state'], o.case_id);
  }
  assert.deepEqual(lifecycleEffects(obsOf('approval-before-cut')), ['approval_granted@0:a', 'permit_issued@1:a']);
  // An initial issued authority's setup approve and issue precede the baseline: no step effect.
  assert.deepEqual(lifecycleEffects(obsOf('permit-single-use')), []);
  assert.deepEqual(lifecycleEffects(obsOf('issue-after-cut')), ['approval_granted@0:a']);
  assert.deepEqual(lifecycleEffects(obsOf('sup-ancestor-revoke-approved-before-issue')), ['approval_granted@0:c']);
  // The consumption is bound to the started execution and to the start request of its own step.
  const o = obsOf('permit-single-use');
  const last = o.probes[o.probes.length - 1].state;
  const lineage = last.lineages![0];
  const startCall = o.calls.find(c => c.step === 0)!;
  assert.equal(lineage.state, 'consumed'); assert.equal(lineage.start_request_id, startCall.request_id);
  assert.equal(last.executions.find(x => x.execution_id === lineage.execution_id)!.label, 'e1');
  assert.deepEqual(o.calls.find(c => c.step === 1), { step: 1, api: 'start', outcome: 'rejected', class: 'LifecycleDeniedError', reason: 'permit_consumed', request_id: o.calls.find(c => c.step === 1)!.request_id });
  assert.deepEqual(lifecycleTransitions(o.probes).transitions.map(t => `${t.kind}@${o.probes[t.probe].step}`), ['permit_consumed@0']);
});

test('decisions: receipts and started tools are ALLOW; revocation and the contract lifecycle denials are DENY; anything else is UNKNOWN', () => {
  const step = (op: 'approve' | 'issue' | 'start') => (op === 'start' ? { op, authority: 'a', execution: 'e1' } : { op, authority: 'a' }) as Case['steps'][number];
  const call = (api: CallRecord['api'], outcome: CallRecord['outcome'], extra: Partial<CallRecord> = {}): CallRecord => ({ step: 0, api, outcome, ...extra });
  assert.equal(decisionFromCall(step('approve'), call('approve', 'returned')), 'ALLOW');
  assert.equal(decisionFromCall(step('approve'), call('approve', 'threw', { class: 'AuthorityRevokedError' })), 'DENY');
  assert.equal(decisionFromCall(step('approve'), call('approve', 'threw', { class: 'LifecycleDeniedError', reason: 'not_pending' })), 'DENY');
  assert.equal(decisionFromCall(step('approve'), call('approve', 'threw', { class: 'LifecycleDeniedError', reason: 'approval_verification_failed' })), 'UNKNOWN');
  assert.equal(decisionFromCall(step('issue'), call('issuePermit', 'returned')), 'ALLOW');
  assert.equal(decisionFromCall(step('issue'), call('issuePermit', 'threw', { class: 'LifecycleDeniedError', reason: 'not_approved' })), 'DENY');
  assert.equal(decisionFromCall(step('issue'), call('issuePermit', 'threw', { class: 'LifecycleDeniedError', reason: 'chain_snapshot_mismatch' })), 'UNKNOWN');
  assert.equal(decisionFromCall(step('start'), call('start', 'tool_invoked')), 'ALLOW');
  for (const reason of ['permit_not_issued', 'permit_consumed']) assert.equal(decisionFromCall(step('start'), call('start', 'rejected', { class: 'LifecycleDeniedError', reason })), 'DENY', reason);
  assert.equal(decisionFromCall(step('start'), call('start', 'rejected', { class: 'LifecycleDeniedError', reason: 'lineage_binding_mismatch:arguments' })), 'UNKNOWN');
  assert.equal(decisionFromCall(step('start'), call('start', 'rejected', { class: 'AuthorityRevokedError' })), 'DENY');
  assert.equal(decisionFromCall(step('start'), call('start', 'fulfilled', { value: '"executed"' })), 'UNKNOWN');
  // Another API than the operation's own is no answer of that operation.
  assert.equal(decisionFromCall(step('approve'), call('issuePermit', 'returned')), 'UNKNOWN');
  assert.equal(decisionFromCall(step('issue'), call('approve', 'returned')), 'UNKNOWN');
  assert.equal(decisionFromCall(step('start'), call('approve', 'returned')), 'UNKNOWN');
  const o = obsOf('approval-before-cut');
  o.calls = o.calls.map(c => (c.step === 1 ? { ...c, api: 'approve' } : c));
  const e = ev(o.case_id, o);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.ok(codes(e).includes('call_api_mismatch'), String(codes(e)));
});

test('AR1 setup state is no step effect: the AM19 report of permit-single-use is effect_without_probe_evidence', () => {
  const id = 'permit-single-use';
  const o = obsOf(id);
  const baseline = o.probes[0].state;
  assert.deepEqual(baseline.lineages!.map(l => [l.state, l.approved_seq! <= baseline.authority_seq!, l.issued_seq! <= baseline.authority_seq!]), [['issued', true, true]]);
  assert.equal(ev(id, rereport(caseOf(id), o)).verdict, 'PASS');
  const am19 = rereport(caseOf(id), o, 'AM19_setup_state_as_step_effects');
  assert.deepEqual(lifecycleEffects(am19), ['approval_granted@0:a', 'permit_issued@0:a']);
  const e = ev(id, am19);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.deepEqual(codes(e), ['effect_without_probe_evidence']);
  assert.equal(e.errors.length, 2);
});

test('AR2 the baseline confirms the initial state: a pending authority shown approved (AM15) is identity_mapping_invalid, and no effect comes from the baseline', () => {
  const id = 'pending-approval';
  const o = obsOf(id);
  const baseSeq = o.probes[0].state.authority_seq!;
  const am15 = editProbes(o, 0, s => { for (const l of s.lineages!) Object.assign(l, { state: 'approved', approval_state: 'approved', approved_seq: baseSeq }); });
  const r = rereport(caseOf(id), am15);
  assert.deepEqual(lifecycleEffects(r), []);
  assert.deepEqual(derive(r.probes, r.identity).effects.filter(x => x.effect.kind === 'approval_granted'), []);
  const e = ev(id, r);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.ok(codes(e).includes('identity_mapping_invalid'), String(codes(e)));
  assert.ok(e.errors.some(x => x.message.includes('not its initial state pending')), JSON.stringify(e.errors));
  // AM17: one authority mapped to two lineages; AM15 of an issued authority shown pending is also refused.
  const two = obsOf('approval-before-cut'); two.identity.lineages!['lineage-99'] = 'a';
  assert.ok(codes(ev(two.case_id, two)).includes('identity_mapping_invalid'));
  const p = obsOf('permit-single-use');
  const pending = clone(p);
  pending.probes[0].state.lineages![0] = { ...pending.probes[0].state.lineages![0], state: 'pending', approval_state: 'pending', approved_seq: null, permit_state: 'none', issued_seq: null };
  assert.ok(codes(ev(p.case_id, rereport(caseOf(p.case_id), pending))).includes('identity_mapping_invalid'));
  // A missing baseline probe, or a lineage that appears after the setup, is refused as well.
  const noBase = obsOf('approval-before-cut'); noBase.probes = noBase.probes.slice(1).map((x, k) => ({ ...x, index: k }));
  assert.ok(codes(ev(noBase.case_id, rereport(caseOf(noBase.case_id), noBase))).includes('identity_mapping_invalid'));
  const late = editProbes(obsOf('approval-before-cut'), 3, s => { s.lineages!.push({ ...s.lineages![0], lineage_id: 'lineage-9' }); });
  assert.ok(codes(ev(late.case_id, rereport(caseOf(late.case_id), late))).includes('identity_mapping_invalid'));
});

test('AR3 no effect without a post-baseline transition: an approval surfacing with approved_seq <= baseline_seq is inconsistent, never PASS', () => {
  const id = 'approval-before-cut';
  const o = obsOf(id);
  const baseSeq = o.probes[0].state.authority_seq!;
  const first = o.probes.findIndex(p => p.state.lineages!.some(l => l.approval_state === 'approved'));
  const late = editProbes(o, first, s => { for (const l of s.lineages!) l.approved_seq = baseSeq; });
  const r = rereport(caseOf(id), late);
  assert.ok(!lifecycleEffects(r).some(x => x.startsWith('approval_granted')), JSON.stringify(lifecycleEffects(r)));
  const e = ev(id, r);
  assert.equal(e.verdict, 'UNASSESSABLE'); assert.deepEqual(e.errors, []);
  assert.ok(e.incomplete.some(x => x.startsWith('inconsistent state evidence') && x.includes(`approved_seq ${baseSeq} is not after the setup baseline`)), JSON.stringify(e.incomplete));
  assert.ok(e.incomplete.includes('expected effect not confirmed: approval_granted at step 0'), JSON.stringify(e.incomplete));
  // The adapter's original report, which still names the approval, has no evidence for it.
  assert.ok(codes(ev(id, late)).includes('effect_without_probe_evidence'));
});

test('AR4 a transition is attributed to its own step: a permit first shown at a revoke step (AM18) is lifecycle_transition_mismatch', () => {
  const id = 'issue-after-cut';
  const o = obsOf(id);
  const at = probeIndex(o, 1, 'barrier_complete');
  const seq = o.probes[at].state.authority_seq!;
  const am18 = editProbes(o, at, s => { for (const l of s.lineages!) Object.assign(l, { state: 'issued', permit_state: 'issued', permit_id: 'permit-1', issued_seq: seq }); });
  const r = rereport(caseOf(id), am18);
  assert.deepEqual(lifecycleEffects(r), ['approval_granted@0:a', 'permit_issued@1:a']);
  const e = ev(id, r);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.ok(codes(e).includes('lifecycle_transition_mismatch'), String(codes(e)));
  assert.ok(e.errors.some(x => x.message.includes('first shown at step 1 (revoke), not at a issue step of a')), JSON.stringify(e.errors));
  // A consumption for another start request than its step submitted is refused too.
  const c = obsOf('permit-single-use');
  for (const p of c.probes) for (const l of p.state.lineages!) if (l.start_request_id) l.start_request_id = 'other-request';
  assert.ok(codes(ev(c.case_id, c)).includes('lifecycle_transition_mismatch'));
  // An execution whose runtime request is not its own step's start request is a binding mismatch.
  const b = obsOf('permit-single-use');
  for (const p of b.probes) for (const x of p.state.executions) x.request_id = b.calls.find(y => y.step === 1)!.request_id;
  assert.ok(codes(ev(b.case_id, b)).includes('runtime_binding_mismatch'));
});

test('AM16 shape: lifecycle effects from receipts are effect_without_probe_evidence when the snapshot does not show the transition', () => {
  const id = 'approval-before-cut';
  const o = obsOf(id);
  // The runtime's snapshot never shows the approval (a receipt without state), the permit is issued as usual.
  const hidden = editProbes(o, 0, s => { for (const l of s.lineages!) Object.assign(l, { approval_state: 'pending', approved_seq: null, state: l.permit_state === 'none' ? 'pending' : l.state }); });
  const correct = ev(id, rereport(caseOf(id), hidden));
  assert.notEqual(correct.verdict, 'PASS');
  assert.ok(findings(correct).includes('missing_approval_granted@0'), JSON.stringify(findings(correct)));
  const am16 = ev(id, rereport(caseOf(id), hidden, 'AM16_lifecycle_effects_from_receipts'));
  assert.equal(am16.verdict, 'HARNESS_ERROR'); assert.ok(codes(am16).includes('effect_without_probe_evidence'), String(codes(am16)));
});

test('observation formats: format 3 profile refuses format 2; the format 3 schema requires lineages, the sequence value and execution requests', () => {
  const old = (JSON.parse(readFileSync(join(root, 'test/fixtures/revocation-runtime/a9deab6-baseline-observations.json'), 'utf8')) as { corpus: RuntimeObservation[] }).corpus.find(x => x.case_id === 'start-before-cut')!;
  assert.deepEqual(codes(ev('start-before-cut', old)), ['observation_format_mismatch']);
  const o = obsOf('start-before-cut');
  assert.deepEqual(codes(ev('start-before-cut', o, 2)), ['observation_format_mismatch']);
  const noLineages = clone(o); delete noLineages.identity.lineages;
  assert.ok(runtimeObservationIssues(noLineages).length > 0);
  const noSeq = clone(o); delete noSeq.probes[1].state.authority_seq;
  assert.ok(runtimeObservationIssues(noSeq).length > 0);
  const noRequest = clone(o); for (const p of noRequest.probes) for (const x of p.state.executions) delete x.request_id;
  assert.ok(runtimeObservationIssues(noRequest).length > 0);
  const legacyApi = clone(o); legacyApi.calls[0].api = 'process';
  assert.ok(runtimeObservationIssues(legacyApi).length > 0);
  const timestamp = clone(o) as unknown as { probes: { state: { lineages: Record<string, unknown>[] } }[] }; timestamp.probes[1].state.lineages[0].expires_at = '2026-01-01T00:00:00Z';
  assert.ok(runtimeObservationIssues(timestamp).length > 0);
  assert.equal(ev('start-before-cut', o).verdict, 'PASS');
});

test('evaluate --observations --profile --lock: the recorded ef775db baseline gives the same evidence, acceptance fields and exit 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-recorded-permit-'));
  try {
    const r = cliRun('evaluate', '--observations', FIXTURE, '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'o'));
    assert.equal(r.status, 3, r.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'o/report.json'), 'utf8'));
    assert.deepEqual(validateProfileReport(report), []);
    const expectedReport = reportWith();
    assert.equal(canonicalJsonLines(report.evidence), canonicalJsonLines(expectedReport.evidence));
    assert.equal(canonicalJsonLines(report.supplement.cases), canonicalJsonLines(expectedReport.supplement.cases));
    for (const k of ['counts', 'technically_valid', 'has_confirmed_violation', 'contract_acceptance_passed', 'profile_acceptance_passed', 'supplement_acceptance_passed'] as const) assert.deepEqual(report[k], expectedReport[k], k);
    assert.equal(readFileSync(join(dir, 'o/observations.json'), 'utf8'), readFileSync(FIXTURE, 'utf8'));
    // The a9deab6 pin's format 2 observations are not accepted by the current profile.
    const old = cliRun('evaluate', '--observations', join(root, 'test/fixtures/revocation-runtime/a9deab6-baseline-observations.json'), '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'old'));
    assert.equal(old.status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: run-adapter, mutants and runtime-gates fail closed before any runtime on bad options or an earlier pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-cli-permit-'));
  try {
    assert.equal(cliRun('mutants', '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'z'), '--only', 'M99').status, 2);
    assert.throws(() => statSync(join(dir, 'z')));
    assert.equal(cliRun('runtime-gates', '--out', join(dir, 'g')).status, 2);
    const legacy = cliRun('runtime-gates', '--lock', 'profiles/revocation/history/sut.revocation.a682e44.lock.json', '--out', join(dir, 'h'));
    assert.equal(legacy.status, 2); assert.match(legacy.stderr, /pins no runtime_test_gates/);
    const unpinned = cliRun('runtime-gates', '--lock', HISTORY, '--out', join(dir, 'u'), '--gates', 'lifecycle');
    assert.equal(unpinned.status, 2); assert.match(unpinned.stderr, /unknown, unpinned or duplicate gate/);
    const tenancy = cliRun('run-adapter', '--lock', HISTORY, '--profile', historyLock.profile, '--out', join(dir, 'w'));
    assert.equal(tenancy.status, 2); assert.match(tenancy.stderr, /tenancy-mode, permit-mode lock and a format 3 profile/);
    assert.throws(() => statSync(join(dir, 'w')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mutant manifest v3: re-verified witnesses, plan rows M12-M52, masked legacy-path mutants, M25 not run; tampering fails closed', () => {
  const { manifest } = loadMutantManifest(root, lock, VERSION);
  assert.equal(manifest.sut_commit, lock.sut_commit);
  assert.deepEqual(manifest.mutants.map(m => m.id), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M10', 'M11', 'M15', 'M16', 'M21', 'M37', 'M28', 'M29', 'M35', 'M36', 'M12', 'M13', 'M14', 'M24', 'M49', 'M50', 'M51', 'M52', 'M25-overreach']);
  assert.deepEqual(manifest.masked.map(m => m.id), ['M8', 'M9', 'M22', 'M20', 'M26', 'M34']);
  assert.deepEqual(manifest.not_run.map(m => m.id), ['M25']);
  const by = (id: string) => manifest.mutants.find(m => m.id === id)!;
  // The plan section 8.1 witnesses, with at least the plan's findings.
  const plan: [string, string, string[]][] = [
    ['M12', 'pending-approval', ['false_allow@1', 'unexpected_approval_granted@1']], ['M13', 'issue-after-cut', ['false_allow@2', 'unexpected_permit_issued@2']],
    ['M14', 'fresh-id-retry-unused-permit', ['false_allow@0', 'unexpected_execution_started@0']], ['M24', 'permit-single-use', ['false_allow@1', 'unexpected_execution_started@1']],
    ['M49', 'fresh-id-retry-unused-permit', ['false_allow@4', 'unexpected_execution_started@4']], ['M50', 'sup-session-revoke-pending-approval', ['false_allow@1', 'unexpected_approval_granted@1']],
    ['M51', 'sup-tenant-revoke-unused-permit', ['false_allow@5', 'unexpected_execution_started@5']], ['M52', 'sup-ancestor-revoke-approved-before-issue', ['false_allow@2', 'unexpected_permit_issued@2']],
  ];
  for (const [id, caseId, minimum] of plan) {
    const w = by(id).witness;
    assert.equal(w.case_id, caseId, id);
    const got = [...w.decision_findings, ...w.effect_findings].map(f => `${f.reason}@${f.step}`);
    for (const f of minimum) assert.ok(got.includes(f), `${id}: ${f}`);
    assert.ok(by(id).plan_kind && by(id).kind_note, id);
  }
  // Lifecycle evidence is never containment; containment witnesses run a tool.
  for (const id of ['M12', 'M13', 'M50', 'M52']) assert.deepEqual(by(id).parts, ['lifecycle'], id);
  for (const id of ['M14', 'M24', 'M49', 'M51']) assert.ok(by(id).parts.includes('containment'), id);
  for (const id of ['M7', 'M16', 'M37']) assert.deepEqual(by(id).parts, ['availability'], id);
  // M25-overreach: a separately authorized mechanism at the issue fence, witnessed by S11 step 5; availability only,
  // never containment, and not a variant of M25 (which stays not run with its coverage gap).
  const overreach = by('M25-overreach');
  assert.equal(overreach.witness.case_id, 'sup-session-revoke-pending-approval');
  assert.deepEqual([...overreach.witness.decision_findings, ...overreach.witness.effect_findings].map(f => `${f.reason}@${f.step}`), ['false_deny@5', 'false_deny@6', 'missing_permit_issued@5', 'missing_execution_started@6']);
  assert.deepEqual(overreach.parts, ['availability']);
  assert.notEqual(overreach.patch_sha256, sha256Hex(readFileSync(join(root, 'mutations/revocation/M25-issue-requires-pending-over-fencing.patch'))));
  assert.deepEqual(overreach.run_exceptions, { harness_errors: [], barrier_timeouts: [] });
  for (const m of manifest.mutants) {
    if (m.source) assert.equal(m.source.commit, lock.sut_commit, m.id);
    const ids = m.witness.set === 'corpus' ? profile.cases.filter(c => c.applicability === 'IN_PROFILE').map(c => c.id) : supplement.cases.map(c => c.id);
    assert.ok(ids.includes(m.witness.case_id), `${m.id} witness ${m.witness.case_id}`);
  }
  for (const m of manifest.masked) assert.ok(m.reason.length > 80 && m.previous_witness?.pin === 'a9deab6', m.id);
  assert.match(manifest.not_run[0].reproduction, /setup_failed/);
  assert.match(manifest.not_run[0].coverage_gap, /no eval mutant evidence/);
  const dir = mkdtempSync(join(tmpdir(), 'rev-mutants-permit-'));
  try {
    mkdirSync(join(dir, 'mutations/revocation'), { recursive: true });
    for (const m of [...manifest.mutants, ...manifest.masked]) copyFileSync(join(root, 'mutations/revocation', m.patch), join(dir, 'mutations/revocation', m.patch));
    const write = (m: unknown) => { const text = JSON.stringify(m, null, 2) + '\n'; writeFileSync(join(dir, MUTANT_MANIFEST), text); writeFileSync(join(dir, MUTANT_MANIFEST.replace(/\.json$/, '.sha256')), sha256Hex(text) + '\n'); };
    write(manifest);
    assert.doesNotThrow(() => loadMutantManifest(dir, lock, VERSION));
    const tamper: [string, (m: typeof manifest) => void, RegExp][] = [
      ['earlier format', m => { m.manifest = 'revocation-sut-mutants/2'; }, /unknown manifest format/],
      ['another SUT', m => { m.sut_commit = historyLock.sut_commit; }, /not the locked SUT/],
      ['parts claim containment', m => { by2(m, 'M12').parts = ['containment']; }, /evidence parts/],
      ['parts dropped', m => { by2(m, 'M14').parts = ['containment']; }, /evidence parts/],
      ['plan kind without note', m => { delete by2(m, 'M13').kind_note; }, /plan_kind and kind_note/],
      ['masked without reason', m => { m.masked[0].reason = ''; }, /needs its reason/],
      ['masked patch hash', m => { m.masked[1].patch_sha256 = '0'.repeat(64); }, /SHA-256/],
      ['masked twice', m => { m.masked.push(clone(m.masked[0])); }, /duplicate mutant id/],
      ['not run without reproduction', m => { m.not_run[0].reproduction = ''; }, /reproduction/],
      ['not run without coverage gap', m => { m.not_run[0].coverage_gap = ''; }, /coverage gap/],
      ['not run also a mutant', m => { m.not_run[0].id = 'M12'; }, /duplicate mutant id/],
      ['no masked list', m => { delete (m as Partial<typeof manifest>).masked; }, /masked and not_run/],
    ];
    for (const [name, edit, message] of tamper) {
      const m = clone(manifest); edit(m); write(m);
      assert.throws(() => loadMutantManifest(dir, lock, VERSION), (e: Error) => e instanceof MutantManifestError && message.test(e.message), name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const by2 = (m: { mutants: RevocationMutant[] }, id: string) => m.mutants.find(x => x.id === id)!;

test('mutant gate classification: whole run first, exceptions only as predeclared; a masked run must equal the control', () => {
  const { manifest } = loadMutantManifest(root, lock, VERSION);
  const by = (id: string) => manifest.mutants.find(m => m.id === id)!;
  const all = [...fixture.corpus, ...fixture.supplement];
  const control: RunFacts = { cases: new Map(all.map(o => [o.case_id, ev(o.case_id, o)])), diagnostics: all.flatMap(o => o.diagnostics.map(d => ({ case_id: o.case_id, ...d }))), exit: 3, confirmed_violation: false };
  assert.deepEqual(unexpectedTechnical(control, null), []);
  const runFor = (m: RevocationMutant): RunFacts => {
    const cases = new Map(control.cases);
    const errorsOf = (id: string) => m.run_exceptions.harness_errors.filter(h => h.case_id === id).map(h => ({ code: h.code, path: h.path, message: h.message }));
    for (const h of m.run_exceptions.harness_errors) cases.set(h.case_id, { ...cases.get(h.case_id)!, verdict: 'HARNESS_ERROR', errors: errorsOf(h.case_id) });
    const w = m.witness;
    cases.set(w.case_id, { ...cases.get(w.case_id)!, verdict: w.verdict, confirmed_violation: w.verdict === 'VIOLATION', decision_findings: w.decision_findings, effect_findings: w.effect_findings, incomplete: w.incomplete, errors: errorsOf(w.case_id) });
    const timeouts = m.run_exceptions.barrier_timeouts.map(t => ({ case_id: t.case_id, step: t.step, code: 'barrier_timeout', detail: t.detail }));
    return { cases, diagnostics: [...control.diagnostics, ...timeouts], exit: w.exit, confirmed_violation: w.run_confirmed_violation };
  };
  for (const m of manifest.mutants) assert.equal(classifyMutantRun(m, runFor(m), control).outcome, 'detected', m.id);
  // M12: a setup failure anywhere is a harness process error, never predeclarable.
  const m12 = runFor(by('M12')); m12.diagnostics.push({ case_id: 'issued-permit', step: null, code: 'setup_failed', detail: 'injected' });
  const r12 = classifyMutantRun(by('M12'), m12, control);
  assert.equal(r12.outcome, 'technical_failure'); assert.ok(r12.technical.some(x => x.includes('setup_failed')), JSON.stringify(r12.technical));
  // M10: exactly its 29 named barrier timeouts, now including the moved and new lifecycle cases.
  assert.equal(by('M10').run_exceptions.barrier_timeouts.length, 29);
  for (const id of ['approval-before-cut', 'permit-single-use', 'sup-session-revoke-pending-approval', 'sup-tenant-revoke-unused-permit', 'sup-ancestor-revoke-unused-permit']) assert.ok(by('M10').run_exceptions.barrier_timeouts.some(t => t.case_id === id), id);
  const m10 = runFor(by('M10')); m10.diagnostics.push({ case_id: 'pending-approval', step: 3, code: 'barrier_timeout', detail: 'injected' });
  assert.equal(classifyMutantRun(by('M10'), m10, control).outcome, 'technical_failure');
  // A run equal to the control survives a mutant; it is the masked outcome of a masked mutant.
  assert.equal(classifyMutantRun(by('M12'), control, control).outcome, 'survived');
  assert.deepEqual(classifyMaskedRun(control, control), { outcome: 'masked', differences: [] });
  const changed: RunFacts = { ...control, cases: new Map(control.cases) };
  changed.cases.set('pending-approval', { ...control.cases.get('pending-approval')!, verdict: 'VIOLATION', decision_findings: [{ reason: 'false_allow', step: 1 }] });
  const masked = classifyMaskedRun(changed, control);
  assert.equal(masked.outcome, 'technical_failure'); assert.ok(masked.differences.some(x => x.startsWith('case pending-approval differs')), JSON.stringify(masked.differences));
  assert.equal(classifyMaskedRun({ ...control, exit: 1 }, control).outcome, 'technical_failure');
  assert.equal(classifyMaskedRun({ ...control, diagnostics: [...control.diagnostics, { case_id: 'issued-permit', step: 1, code: 'drift', detail: 'injected' }] }, control).outcome, 'technical_failure');
  // Evidence parts are derived from the pinned values alone.
  assert.deepEqual(witnessParts({ verdict: 'VIOLATION', decision_findings: [{ reason: 'false_deny', step: 1 }], effect_findings: [{ reason: 'missing_permit_issued', step: 1 }] }), ['availability']);
  assert.deepEqual(witnessParts({ verdict: 'VIOLATION', decision_findings: [{ reason: 'false_allow', step: 1 }], effect_findings: [] }), ['check_point']);
  assert.deepEqual(witnessParts({ verdict: 'UNASSESSABLE', decision_findings: [], effect_findings: [] }), ['missing_evidence']);
});

test('runtime gate reports: a kind outside the gate\'s own is accepted only when empty; own kinds are required', () => {
  const g = lock.runtime_test_gates!;
  const empty = { lifecycle_effect: [], check_and_lifecycle: [], availability_effect: [], check_and_availability: [] };
  // The v0.6.0 driver reports all eight kinds for the tenant and ancestor gates, the lifecycle ones empty.
  for (const gate of ['tenant', 'ancestor'] as const) {
    const evidence = { ...g[gate].evidence, ...empty };
    assert.deepEqual(evidenceKindIssues(gate, evidence), [], gate);
    assert.deepEqual(evidenceKindIssues(gate, g[gate].evidence), [], `${gate}: the four kinds alone`);
    assert.match(evidenceKindIssues(gate, { ...evidence, check_and_lifecycle: ['M15'] }).join(), /check_and_lifecycle outside this gate's kinds is not empty/);
    assert.match(evidenceKindIssues(gate, { ...evidence, invented_kind: [] }).join(), /invented_kind outside this gate's kinds/);
    const { both: _both, ...withoutBoth } = evidence;
    assert.match(evidenceKindIssues(gate, withoutBoth).join(), /kind both missing/);
  }
  assert.deepEqual(evidenceKindIssues('lifecycle', g.lifecycle!.evidence), []);
  const { check_and_availability: _a, ...noAvailability } = g.lifecycle!.evidence;
  assert.match(evidenceKindIssues('lifecycle', noAvailability).join(), /kind check_and_availability missing/);
});
