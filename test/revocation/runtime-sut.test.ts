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

/**
 * Runs one IN_PROFILE case against the pinned runtime with a test double around one executor read surface (the
 * prototype is restored afterwards). These reproduce the review experiments: the adapter must read the evidence the
 * specification requires, so a runtime that hides it can never PASS.
 */
async function withPatchedExecutor(id: string, patch: (proto: Record<string, unknown>) => () => void) {
  const { profile } = loadProfile(root, lock.profile, cases, corpusSha, VERSION, lock.sut_commit);
  const { supplement } = loadSupplement(root, lock.supplement, VERSION, lock.sut_commit);
  const proto = loadRevocationSut(env!.build).GuardedExecutor.prototype as Record<string, unknown>;
  const restore = patch(proto);
  try {
    return (await runProfile(env!.build, cases, cases.map(expected), profile, supplement, { only: x => x === id })).corpus[0].evidence;
  } finally { restore(); }
}
const wrapMethod = (proto: Record<string, unknown>, name: string, f: (original: (...a: unknown[]) => unknown) => (this: unknown, ...a: unknown[]) => unknown) => {
  const original = proto[name] as (...a: unknown[]) => unknown;
  proto[name] = f(original);
  return () => { proto[name] = original; };
};

test('pinned runtime, review experiment: snapshot terminal record removed and terminals() empty -> not PASS', { skip }, async () => {
  const e = await withPatchedExecutor('start-before-cut', proto => {
    const r1 = wrapMethod(proto, 'getExecution', original => function (this: unknown, ...a: unknown[]) { const s = original.apply(this, a) as Record<string, unknown> | undefined; if (s) delete s.terminal; return s; });
    const r2 = wrapMethod(proto, 'terminals', () => function () { return []; });
    return () => { r1(); r2(); };
  });
  assert.notEqual(e.verdict, 'PASS'); assert.deepEqual(e.errors, []);
  assert.ok(e.incomplete.some(x => x.includes('no terminal record in the snapshot')), JSON.stringify(e.incomplete));
});

test('pinned runtime: terminal record bound to another execution -> not PASS', { skip }, async () => {
  const e = await withPatchedExecutor('session-in-flight-commit-fence', proto => wrapMethod(proto, 'getExecution', original => function (this: unknown, ...a: unknown[]) {
    const s = original.apply(this, a) as { terminal?: { execution_id: string } } | undefined;
    if (s?.terminal) s.terminal = { ...s.terminal, execution_id: `${s.terminal.execution_id}-other` };
    return s;
  }));
  assert.notEqual(e.verdict, 'PASS'); assert.deepEqual(e.errors, []);
  assert.ok(e.incomplete.some(x => x.includes('terminal record names')), JSON.stringify(e.incomplete));
});

test('pinned runtime, review experiment: managed state lists the key but get() is undefined and version stays 0 -> not PASS', { skip }, async () => {
  const e = await withPatchedExecutor('commit-before-cut', proto => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'managedState')!;
    Object.defineProperty(proto, 'managedState', { configurable: true, get(this: unknown) {
      const real = descriptor.get!.call(this) as { keys: () => string[]; has: (k: string) => boolean };
      return { keys: () => real.keys(), has: (k: string) => real.has(k), get: () => undefined, version: 0 };
    } });
    return () => { Object.defineProperty(proto, 'managedState', descriptor); };
  });
  assert.notEqual(e.verdict, 'PASS'); assert.deepEqual(e.errors, []);
  assert.ok(e.incomplete.some(x => x.includes('get(key) returned undefined')), JSON.stringify(e.incomplete));
});
