/**
 * revocation-0.4.0 declared-profile tests of the current pin (acs-guardrail-demo@a9deab6, v0.5.0, tenancy mode,
 * runtime observation format 2) that need no SUT: they evaluate the committed observations of that runtime's
 * baseline run (test/fixtures/revocation-runtime/a9deab6-baseline-observations.json, byte-compared against a fresh run
 * in runtime-sut.test.ts) and controlled edits of them that simulate adapter or SUT behaviour the baseline does not
 * show. The format 1 path of the earlier pin stays covered by runtime-profile.test.ts.
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
import { Case, Evidence, RuntimeObservation, VERSION } from '../../src/spec/revocation/model';
import { classify, LEGACY_RULES, rulesOf } from '../../src/profile/revocation/classifier';
import { controlSteps, loadProfile, loadSupplement } from '../../src/profile/revocation/profile';
import { buildProfileReport, profileExitCode } from '../../src/report/revocation/profile-report';
import { runtimeObservationIssues, validateProfileReport } from '../../src/report/revocation/validate';
import { identityFor, sessionIdFor } from '../../src/adapter/revocation-runtime/runner';
import { loadMutantManifest, MUTANT_MANIFEST, MutantManifestError, witnessFailures } from '../../src/mutation/revocation/mutants';
import { loadRevocationLock, RevocationLockError } from '../../src/sut/revocation-lock';
import { canonicalJsonLines } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';

const LOCK = 'sut.revocation.lock.json';
const { lock, sha256: lockSha256 } = loadRevocationLock(join(root, LOCK), VERSION);
const corpusSha = sha256Hex(canonicalJsonLines(cases));
const { profile, sha256: profileSha } = loadProfile(root, lock.profile, cases, corpusSha, VERSION, lock.sut_commit);
const { supplement, sha256: supplementSha } = loadSupplement(root, lock.supplement, VERSION, lock.sut_commit);
const FIXTURE = join(root, 'test/fixtures/revocation-runtime/a9deab6-baseline-observations.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { corpus: RuntimeObservation[]; supplement: RuntimeObservation[] };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const caseOf = (id: string): Case => cases.find(c => c.id === id) ?? (() => { const s = supplement.cases.find(x => x.id === id)!; return { id: s.id, family: s.family, authorities: s.authorities, steps: s.steps }; })();
const truthOf = (id: string) => supplement.cases.find(x => x.id === id)?.expected ?? expected(caseOf(id));
const obsOf = (id: string) => clone([...fixture.corpus, ...fixture.supplement].find(o => o.case_id === id)!);
const ev = (id: string, o: unknown, format: 1 | 2 = 2) => evaluate(caseOf(id), truthOf(id), o, { ordering: 'probe_seq', controlSteps: controlSteps(caseOf(id)), observationFormat: format });
const codes = (e: Evidence) => [...new Set(e.errors.map(x => x.code))].sort();
const findings = (e: Evidence) => [...e.decision_findings, ...e.effect_findings].map(f => `${f.reason}@${f.step}`).sort();
const cliRun = (...args: string[]) => spawnSync(process.execPath, [join(root, 'dist/src/revocation-cli.js'), ...args], { cwd: root, encoding: 'utf8' });

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

const MOVED = ['tenant-multi-session-in-flight', 'tenant-isolation', 'derived-in-flight-ancestor-revoked'];

test('pin: v0.5.0 at a9deab6 in tenancy mode, tag and content hashes bound, ACS pin unchanged', () => {
  assert.equal(lock.sut_commit, 'a9deab6709d6ca2ba8f3988693b50fa807eadc0c');
  assert.equal(lock.sut_tree, 'dc25f122da3183c14cd70fa14deabdd4d1b1fe45');
  assert.equal(lock.sut_version, '0.5.0');
  assert.deepEqual(lock.sut_tag, { name: 'v0.5.0', object: 'f0626086faf5757e58fa1a746d4b12fe1ceb3e47' });
  assert.equal(lock.sut_package_lock_sha256, '6d40e36d07aeaaa8546be5c1c223ede585828db72d26d067c399988c27649e4c');
  assert.equal(lock.sut_runtime_mode, 'tenancy'); assert.equal(lock.max_chain_length, 8);
  assert.deepEqual([lock.baseline_at_pin.test_suites, lock.baseline_at_pin.tests], [30, 628]);
  assert.equal(JSON.parse(readFileSync(join(root, 'sut.lock.json'), 'utf8')).sut_commit, '403d31593a0d57187df3f5e1ef3df6127baaefb9');
  // The earlier pin is kept byte for byte for the recorded format 1 path.
  assert.equal(loadRevocationLock(join(root, 'profiles/revocation/history/sut.revocation.a682e44.lock.json'), VERSION).lock.sut_commit, 'a682e4479dbccd1cd5f665f5d4879bd3dddb8b47');
});

test('lock: conflicting tag, mode, chain length and runtime gate bindings fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-lock-tenancy-'));
  try {
    const good = JSON.parse(readFileSync(join(root, LOCK), 'utf8'));
    const gates = good.runtime_test_gates;
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['tag of another version', { sut_tag: { name: 'v0.4.0', object: good.sut_tag.object } }, /does not name sut_version/],
      ['tag object not a SHA', { sut_tag: { name: 'v0.5.0', object: 'v0.5.0' } }, /annotated tag object/],
      ['tag object is the commit', { sut_tag: { name: 'v0.5.0', object: good.sut_commit } }, /not the commit/],
      ['unknown mode', { sut_runtime_mode: 'mixed' }, /neither tenancy nor legacy/],
      ['tenancy without chain length', { max_chain_length: undefined }, /needs max_chain_length/],
      ['zero chain length', { max_chain_length: 0 }, /needs max_chain_length/],
      ['legacy with chain length', { sut_runtime_mode: 'legacy' }, /tenancy mode only/],
      ['gate manifest hash', { runtime_test_gates: { ...gates, tenant: { ...gates.tenant, manifest_sha256: 'abc' } } }, /manifest_sha256/],
      ['gate command', { runtime_test_gates: { ...gates, ancestor: { ...gates.ancestor, command: 'sh -c true' } } }, /npm run command/],
      ['gate evidence kinds', { runtime_test_gates: { ...gates, tenant: { ...gates.tenant, evidence: { both: ['M15'] } } } }, /exactly the kinds/],
      ['duplicate mutant', { runtime_test_gates: { ...gates, tenant: { ...gates.tenant, evidence: { ...gates.tenant.evidence, check_point: [...gates.tenant.evidence.check_point, 'M15'] } } } }, /exactly once/],
      ['gate gaps', { runtime_test_gates: { ...gates, tenant: { ...gates.tenant, recorded_gaps: 'M33' } } }, /recorded_gaps/],
      ['regression exits', { runtime_test_gates: { ...gates, regressions: { ...gates.regressions, cases: { 'R1-inventory': 'two' } } } }, /integer case exits/],
    ];
    for (const [name, patch, message] of bad) {
      writeFileSync(join(dir, 'lock.json'), JSON.stringify({ ...good, ...patch }));
      assert.throws(() => loadRevocationLock(join(dir, 'lock.json'), VERSION), (e: Error) => e instanceof RevocationLockError && message.test(e.message), name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('profile: 17 IN_PROFILE / 10 OUT_OF_SCOPE from the declared revoke scopes; derived-authority stays out; K = 43', () => {
  assert.equal(profile.observation_format, 2);
  assert.deepEqual([...profile.supported.revoke.scopes].sort(), ['authority_with_descendants', 'session', 'tenant']);
  const rules = rulesOf(profile.supported.revoke.scopes);
  assert.deepEqual(rules, { tenant_scope: true, descendant_coverage: true });
  assert.equal(profile.cases.filter(c => c.applicability === 'IN_PROFILE').length, 17);
  assert.equal(profile.cases.filter(c => c.applicability === 'OUT_OF_SCOPE').length, 10);
  for (const c of cases) {
    const k = classify(c, expected(c), rules);
    const p = profile.cases.find(x => x.id === c.id)!;
    assert.equal(k.applicability, p.applicability, c.id);
    assert.deepEqual(k.not_assessed_requirements, p.not_assessed_requirements, c.id);
  }
  for (const id of MOVED) {
    assert.equal(profile.cases.find(c => c.id === id)!.applicability, 'IN_PROFILE', id);
    assert.equal(classify(caseOf(id), expected(caseOf(id)), LEGACY_RULES).applicability, 'OUT_OF_SCOPE', `${id} needs the new capability rules`);
  }
  assert.equal(profile.cases.find(c => c.id === 'derived-authority')!.applicability, 'OUT_OF_SCOPE');
  assert.equal(profile.cases.filter(c => c.applicability === 'IN_PROFILE').reduce((n, c) => n + c.not_assessed_requirements.length, 0), 43);
  assert.equal(profile.cases.filter(c => MOVED.includes(c.id)).reduce((n, c) => n + c.not_assessed_requirements.length, 0), 9);
  // The golden corpus is unchanged.
  assert.equal(readFileSync(join(root, 'corpus/revocation/smoke.sha256'), 'utf8').trim(), corpusSha);
});

test('supplement S1-S10: versioned, hash-bound, oracle-checked; S1-S4 unchanged from the earlier supplement', () => {
  assert.equal(supplement.sut_lock.sut_commit, lock.sut_commit);
  assert.deepEqual(supplement.cases.map(c => c.id), [
    'sup-pending-approval-revoked', 'sup-pending-approval-control', 'sup-commit-after-terminal-no-revocation', 'sup-unobservable-pending-settlement',
    'sup-ancestor-revoked-child-start', 'sup-ancestor-control', 'sup-tenant-pending-approval-revoked', 'sup-ancestor-pending-approval-revoked', 'sup-tenant-fences-in-flight', 'sup-ancestor-fences-in-flight',
  ]);
  const old = loadSupplement(root, 'profiles/revocation/acs-guardrail-demo-a682e44.supplement.json', VERSION, 'a682e4479dbccd1cd5f665f5d4879bd3dddb8b47').supplement;
  for (let i = 0; i < 4; i++) assert.deepEqual(supplement.cases[i], old.cases[i], old.cases[i].id);
  assert.equal(sha256Hex(readFileSync(join(root, lock.supplement))), readFileSync(join(root, lock.supplement.replace(/\.json$/, '.sha256')), 'utf8').trim());
});

test('baseline: 17/17 PASS, supplement S1-S10 as declared, K = 43, exit 3, never a contract pass', () => {
  const r = reportWith();
  assert.deepEqual(validateProfileReport(r), []);
  assert.equal(r.counts.PASS, 17); assert.equal(r.counts.in_profile, 17); assert.equal(r.counts.out_of_scope, 10); assert.equal(r.counts.corpus_total, 27);
  assert.equal(r.counts.not_assessed_requirements, 43);
  for (const e of r.evidence.filter(x => x.applicability === 'OUT_OF_SCOPE')) assert.equal(e.verdict, null);
  assert.deepEqual(r.supplement.cases.map(s => [s.case_id, s.evidence.verdict, s.matches_declaration]), supplement.cases.map(c => [c.id, c.id === 'sup-unobservable-pending-settlement' ? 'UNASSESSABLE' : 'PASS', true]));
  assert.equal(r.contract_acceptance_passed, false); assert.equal(r.profile_acceptance_passed, true); assert.equal(r.supplement_acceptance_passed, true);
  assert.equal(r.technically_valid, true); assert.equal(profileExitCode(r), 3);
  for (const o of [...fixture.corpus, ...fixture.supplement]) assert.deepEqual(runtimeObservationIssues(o), [], o.case_id);
});

test('evidence: the tenant revocation is one tenant receipt, the ancestor revocation one capability receipt; executions carry tenant and chain', () => {
  const tm = obsOf('tenant-multi-session-in-flight');
  const receipts = tm.probes[tm.probes.length - 1].state.receipts;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].target.scope, 'tenant');
  const d = obsOf('derived-in-flight-ancestor-revoked');
  const last = d.probes[d.probes.length - 1].state;
  assert.deepEqual(last.receipts.map(r => r.target.scope), ['capability']);
  const [aCap] = Object.entries(d.identity.capabilities).find(([, a]) => a === 'a')!;
  assert.deepEqual(last.receipts[0].target, { scope: 'capability', capability_id: aCap });
  const child = last.executions.find(x => x.label === 'e2')!;
  assert.deepEqual(child.ancestor_capability_ids, [aCap]);
  assert.equal(d.identity.tenants![child.tenant_id!], 't1');
  // sibling-isolation: both children are bound to the chain of their parent a, which the child revocation never reaches.
  const s = obsOf('sibling-isolation');
  for (const x of s.probes[s.probes.length - 1].state.executions) if (s.identity.capabilities[x.capability_id!] !== 'a') assert.equal(x.ancestor_capability_ids!.length, 1, x.label);
});

test('AM11 shape: a tenant revocation expressed as session revocations is revocation_target_mismatch, never PASS', () => {
  for (const id of ['tenant-multi-session-in-flight', 'sup-tenant-fences-in-flight', 'sup-tenant-pending-approval-revoked']) {
    const o = obsOf(id);
    const step = o.probes[o.probes.length - 1].state.receipts[0].step;
    const sessions = Object.entries(o.identity.sessions).filter(([, p]) => p.tenant === 't1').map(([sid]) => ({ step, target: { scope: 'session' as const, session_id: sid } }));
    for (const p of o.probes) if (p.state.receipts.length) p.state.receipts = sessions;
    const e = ev(id, o);
    assert.equal(e.verdict, 'HARNESS_ERROR', id); assert.ok(codes(e).includes('revocation_target_mismatch'), `${id}: ${codes(e)}`);
  }
  // A receipt of another target, or one at a step that is no revocation, fails too.
  const o = obsOf('derived-in-flight-ancestor-revoked');
  const childCap = Object.entries(o.identity.capabilities).find(([, a]) => a === 'child')![0];
  for (const p of o.probes) for (const r of p.state.receipts) r.target = { scope: 'capability', capability_id: childCap };
  assert.ok(codes(ev(o.case_id, o)).includes('revocation_target_mismatch'));
  const late = obsOf('start-before-cut');
  for (const p of late.probes) for (const r of p.state.receipts) r.step = 0;
  assert.ok(codes(ev(late.case_id, late)).includes('revocation_target_mismatch'));
});

test('AM12/AM13 shape: a tenant-blind session mapping or dropped parent links are identity_mapping_invalid', () => {
  const t = obsOf('tenant-isolation');
  t.identity = identityFor(caseOf('tenant-isolation'), 'AM12_tenant_blind_session_mapping');
  const e12 = ev('tenant-isolation', t);
  assert.equal(e12.verdict, 'HARNESS_ERROR'); assert.ok(codes(e12).includes('identity_mapping_invalid'), String(codes(e12)));
  for (const id of ['derived-in-flight-ancestor-revoked', 'sibling-isolation', 'sup-ancestor-revoked-child-start']) {
    const o = obsOf(id);
    o.identity = identityFor(caseOf(id), 'AM13_drop_parent_links');
    const e = ev(id, o);
    assert.equal(e.verdict, 'HARNESS_ERROR', id); assert.ok(codes(e).includes('identity_mapping_invalid'), `${id}: ${codes(e)}`);
  }
  // The baseline mapping is exactly the adapter's declared mapping.
  for (const o of [...fixture.corpus, ...fixture.supplement]) assert.deepEqual(o.identity, identityFor(caseOf(o.case_id)), o.case_id);
});

test('runtime binding: an execution bound to another tenant or chain than its capability\'s mapping is runtime_binding_mismatch', () => {
  const d = obsOf('derived-in-flight-ancestor-revoked');
  for (const p of d.probes) for (const x of p.state.executions) x.ancestor_capability_ids = [];
  const e1 = ev(d.case_id, d);
  assert.equal(e1.verdict, 'HARNESS_ERROR'); assert.ok(codes(e1).includes('runtime_binding_mismatch'));
  const t = obsOf('tenant-isolation');
  const [other] = Object.keys(t.identity.tenants!).filter(rt => t.identity.tenants![rt] === 't2');
  for (const p of t.probes) for (const x of p.state.executions) x.tenant_id = other;
  const e2 = ev(t.case_id, t);
  assert.equal(e2.verdict, 'HARNESS_ERROR'); assert.ok(codes(e2).includes('runtime_binding_mismatch'));
  // A session bound to its pair's runtime session id is not enough: the tenant must match too.
  assert.ok(Object.keys(t.identity.sessions).includes(sessionIdFor('tenant-isolation', 't1', 's1')));
});

test('observation formats: a profile binds its format; the format 2 schema requires tenants, chains and execution bindings', () => {
  const o = obsOf('start-before-cut');
  const v1 = clone(o) as unknown as Record<string, unknown>; delete v1.format;
  assert.deepEqual(codes(ev('start-before-cut', v1)), ['observation_format_mismatch']);
  assert.deepEqual(codes(ev('start-before-cut', o, 1)), ['observation_format_mismatch']);
  const noTenants = clone(o); delete noTenants.identity.tenants;
  assert.ok(runtimeObservationIssues(noTenants).length > 0);
  const noChains = clone(o); delete noChains.identity.chains;
  assert.ok(runtimeObservationIssues(noChains).length > 0);
  const noBinding = clone(o); for (const p of noBinding.probes) for (const x of p.state.executions) delete (x as { tenant_id?: unknown }).tenant_id;
  assert.ok(runtimeObservationIssues(noBinding).length > 0);
  const tenantTarget = obsOf('tenant-isolation');
  assert.deepEqual(runtimeObservationIssues(tenantTarget), []);
  assert.equal(ev('start-before-cut', o).verdict, 'PASS');
});

test('mutant manifest: golden-hashed, bound to the pin, exact witnesses and evidence kinds; tampering fails closed', () => {
  const { manifest } = loadMutantManifest(root, lock, VERSION);
  assert.deepEqual(manifest.mutants.map(m => m.id), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M15', 'M16', 'M21', 'M22', 'M37', 'M20', 'M26', 'M34', 'M28', 'M29', 'M35', 'M36']);
  assert.deepEqual(manifest.mutants.filter(m => m.witness.set === 'corpus' && Number(m.id.slice(1)) >= 15).map(m => m.id), ['M15', 'M16', 'M21', 'M22', 'M37']);
  assert.deepEqual(manifest.mutants.filter(m => m.witness.set === 'supplement' && Number(m.id.slice(1)) >= 15).map(m => m.id), ['M20', 'M26', 'M34', 'M28', 'M29', 'M35', 'M36']);
  for (const m of manifest.mutants) {
    if (m.source) assert.equal(m.source.commit, lock.sut_commit, m.id);
    const ids = m.witness.set === 'corpus' ? profile.cases.filter(c => c.applicability === 'IN_PROFILE').map(c => c.id) : supplement.cases.map(c => c.id);
    assert.ok(ids.includes(m.witness.case_id), `${m.id} witness ${m.witness.case_id}`);
  }
  // Exact matching: an extra or missing finding, other incompleteness or another exit is no detection.
  const m15 = manifest.mutants.find(m => m.id === 'M15')!;
  const hit: Evidence = { case_id: m15.witness.case_id, family: 'active_session', state_at_cut: [], verdict: 'VIOLATION', confirmed_violation: true, decision_findings: m15.witness.decision_findings, effect_findings: m15.witness.effect_findings, incomplete: m15.witness.incomplete, errors: [] };
  assert.deepEqual(witnessFailures(m15.witness, hit, m15.witness.exit), []);
  assert.notDeepEqual(witnessFailures(m15.witness, { ...hit, effect_findings: [...hit.effect_findings, { reason: 'unexpected_output_delivery', step: 6 }] }, m15.witness.exit), []);
  assert.notDeepEqual(witnessFailures(m15.witness, { ...hit, decision_findings: hit.decision_findings.slice(1) }, m15.witness.exit), []);
  assert.notDeepEqual(witnessFailures(m15.witness, { ...hit, incomplete: ['x'] }, m15.witness.exit), []);
  assert.notDeepEqual(witnessFailures(m15.witness, hit, 2), []);
  const dir = mkdtempSync(join(tmpdir(), 'rev-mutants-'));
  try {
    mkdirSync(join(dir, 'mutations/revocation'), { recursive: true });
    const copyAll = () => { for (const m of manifest.mutants) copyFileSync(join(root, 'mutations/revocation', m.patch), join(dir, 'mutations/revocation', m.patch)); };
    const write = (m: unknown) => { const text = JSON.stringify(m, null, 2) + '\n'; writeFileSync(join(dir, MUTANT_MANIFEST), text); writeFileSync(join(dir, MUTANT_MANIFEST.replace(/\.json$/, '.sha256')), sha256Hex(text) + '\n'); };
    copyAll();
    write(manifest);
    assert.doesNotThrow(() => loadMutantManifest(dir, lock, VERSION));
    writeFileSync(join(dir, MUTANT_MANIFEST.replace(/\.json$/, '.sha256')), '0'.repeat(64) + '\n');
    assert.throws(() => loadMutantManifest(dir, lock, VERSION), /golden/);
    const tamper: [string, (m: typeof manifest) => void, RegExp][] = [
      ['another SUT', m => { m.sut_commit = '0'.repeat(40); }, /not the locked SUT/],
      ['another profile', m => { m.profile = 'profiles/revocation/acs-guardrail-demo-a682e44.profile.json'; }, /another profile/],
      ['patch hash', m => { m.mutants[0].patch_sha256 = '0'.repeat(64); }, /SHA-256/],
      ['copied patch source', m => { m.mutants.find(x => x.id === 'M15')!.source!.sha256 = '0'.repeat(64); }, /differs from its source/],
      ['kind mismatch', m => { m.mutants.find(x => x.id === 'M1')!.evidence_kind = 'decision_and_effect'; }, /does not match its expected values/],
      ['duplicate id', m => { m.mutants.push(clone(m.mutants[0])); }, /duplicate mutant id/],
      ['no exit reason', m => { m.mutants[0].witness.exit_reason = ''; }, /exit_reason/],
      ['baseline exit', m => { m.baseline.exit = 0; }, /baseline exit/],
    ];
    for (const [name, edit, message] of tamper) {
      const m = clone(manifest); edit(m); write(m);
      assert.throws(() => loadMutantManifest(dir, lock, VERSION), (e: Error) => e instanceof MutantManifestError && message.test(e.message), name);
    }
    write(manifest);
    writeFileSync(join(dir, 'mutations/revocation', manifest.mutants[0].patch), 'changed');
    assert.throws(() => loadMutantManifest(dir, lock, VERSION), /SHA-256/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evaluate --observations --profile --lock: the recorded a9deab6 baseline gives the same evidence, acceptance fields and exit 3', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-recorded-tenancy-'));
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
    // The earlier pin's format 1 observations are not accepted by the current profile.
    const old = cliRun('evaluate', '--observations', join(root, 'test/fixtures/revocation-runtime/a682e44-baseline-observations.json'), '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'old'));
    assert.equal(old.status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: mutants and runtime-gates fail closed before any runtime on bad options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rev-cli-tenancy-'));
  try {
    assert.equal(cliRun('mutants', '--lock', LOCK, '--profile', lock.profile, '--out', join(dir, 'z'), '--only', 'M99').status, 2);
    assert.throws(() => statSync(join(dir, 'z')));
    assert.equal(cliRun('runtime-gates', '--out', join(dir, 'g')).status, 2);
    const legacy = cliRun('runtime-gates', '--lock', 'profiles/revocation/history/sut.revocation.a682e44.lock.json', '--out', join(dir, 'h'));
    assert.equal(legacy.status, 2); assert.match(legacy.stderr, /pins no runtime_test_gates/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
