/**
 * Tests against the real pinned runtime build. They run when ACE_REVOCATION_WORK names a work directory in which
 * `ace:revocation run-adapter` prepared the baseline environment (envs/baseline/{checkout,build}); otherwise skipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cases, root } from './helpers';
import { VERSION } from '../../src/spec/revocation/model';
import { canonicalJson, canonicalJsonLines } from '../../src/util/canonical-json';
import { loadRevocationLock, verifyRevocationCheckout } from '../../src/sut/revocation-lock';
import { loadRevocationSut } from '../../src/adapter/revocation-runtime/sut';
import { requestDisciplineIssues, runCase, sessionDisciplineIssues } from '../../src/adapter/revocation-runtime/runner';
import { controlSteps, loadProfile, loadSupplement } from '../../src/profile/revocation/profile';
import { observationsOf, runProfile } from '../../src/eval/revocation/runtime-run';
import { expected } from '../../src/oracle/revocation/expected';
import { sha256Hex } from '../../src/util/hash';

const work = process.env.ACE_REVOCATION_WORK ?? '';
const env = work ? { checkout: join(work, 'envs/baseline/checkout'), build: join(work, 'envs/baseline/build') } : null;
const skip = !env || !existsSync(env.build) ? 'ACE_REVOCATION_WORK with a prepared baseline environment is not set' : false;
const { lock } = loadRevocationLock(join(root, 'sut.revocation.lock.json'), VERSION);
const corpusSha = sha256Hex(canonicalJsonLines(cases));

test('pinned runtime: a fresh baseline run reproduces the committed fixture observations byte for byte', { skip }, async () => {
  const { profile } = loadProfile(root, lock.profile, cases, corpusSha, VERSION, lock.sut_commit);
  const { supplement } = loadSupplement(root, lock.supplement, VERSION, lock.sut_commit);
  const run = await runProfile(env!.build, cases, cases.map(expected), profile, supplement);
  const fixture = readFileSync(join(root, 'test/fixtures/revocation-runtime/a682e44-baseline-observations.json'), 'utf8');
  assert.equal(canonicalJson(observationsOf(run)) + '\n', fixture);
  for (const r of [...run.corpus, ...run.supplement]) {
    assert.deepEqual(requestDisciplineIssues(r.run), [], r.c.id);
    assert.deepEqual(sessionDisciplineIssues({ id: r.c.id, authorities: r.c.authorities, steps: r.c.steps }, r.run.observation), [], r.c.id);
    assert.equal(r.run.clearSessionCalls, 0);
    assert.equal(r.run.constructorGetterCalls, 0);
  }
});

test('pinned runtime: acknowledgeCancellation() is false for an already-terminal execution (cancel_ack_after_runtime_terminal)', { skip }, async () => {
  const sut = loadRevocationSut(env!.build);
  const c = { id: 'conformance-cancel-ack-after-terminal', authorities: [{ id: 'a', tenant: 't1', session: 's1', parent: null, initial: 'issued' as const }],
    steps: [{ op: 'start' as const, authority: 'a', execution: 'e1' }, { op: 'finish' as const, authority: 'a', execution: 'e1' }, { op: 'revoke' as const, target: { scope: 'authority' as const, id: 'a' } }, { op: 'cancel_ack' as const, authority: 'a', execution: 'e1' }, { op: 'seal' as const }] };
  const r = await runCase(c, sut, { watchdogMs: 2000, controlSteps: controlSteps(c) });
  assert.deepEqual(r.observation.calls.find(x => x.step === 3), { step: 3, api: 'acknowledgeCancellation', outcome: 'returned', value: false });
  assert.ok(r.observation.effects.some(f => f.kind === 'execution_terminal' && f.step === 1));
  assert.ok(!r.observation.effects.some(f => f.kind === 'cancellation_ack'));
});

test('pinned runtime: checkout verification fails closed on a wrong commit, tree or package-lock and on a dirty worktree', { skip }, () => {
  assert.doesNotThrow(() => verifyRevocationCheckout(lock, env!.checkout));
  assert.throws(() => verifyRevocationCheckout({ ...lock, sut_commit: '403d31593a0d57187df3f5e1ef3df6127baaefb9' }, env!.checkout), /HEAD/);
  assert.throws(() => verifyRevocationCheckout({ ...lock, sut_tree: '0'.repeat(40) }, env!.checkout), /tree/);
  assert.throws(() => verifyRevocationCheckout({ ...lock, sut_package_lock_sha256: '0'.repeat(64) }, env!.checkout), /package-lock/);
  const stray = join(env!.checkout, 'ace-dirty-marker.txt');
  writeFileSync(stray, 'dirty');
  try { assert.throws(() => verifyRevocationCheckout(lock, env!.checkout), /not clean/); } finally { rmSync(stray, { force: true }); }
});
