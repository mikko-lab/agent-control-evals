import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, canonicalJsonLines } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';
import { evaluateRun } from '../../src/external-actions/eval/run';
import { loadProfile, PATHS, subProfile } from '../../src/external-actions/self-test';
import { fixture, root } from './helpers';

const cli = join(root, 'dist/src/external-actions-cli.js');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]);
const dir = mkdtempSync(join(tmpdir(), 'external-actions-cli-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const { profile, sha256 } = loadProfile(root);

test('CLI self-test: two runs are byte-identical and every SHA binding verifies', () => {
  assert.equal(run('self-test', '--out', join(dir, 'a')).status, 0);
  assert.equal(run('self-test', '--out', join(dir, 'b')).status, 0);
  const a = files(join(dir, 'a')).map(f => relative(join(dir, 'a'), f)).sort();
  assert.deepEqual(a, files(join(dir, 'b')).map(f => relative(join(dir, 'b'), f)).sort());
  for (const f of a) assert.deepEqual(readFileSync(join(dir, 'a', f)), readFileSync(join(dir, 'b', f)), f);
  const m = JSON.parse(readFileSync(join(dir, 'a/manifest.json'), 'utf8'));
  assert.equal(m.evidence_kind, 'synthetic_harness_validation');
  assert.equal(sha256Hex(canonicalJson(m.implementation)), m.implementation_sha256);
  for (const f of m.implementation) assert.equal(sha256Hex(readFileSync(join(root, f.path))), f.sha256, f.path);
  for (const f of m.files) assert.equal(sha256Hex(readFileSync(join(dir, 'a', f.path))), f.sha256, f.path);
  const s = JSON.parse(readFileSync(join(dir, 'a/sensitivity.json'), 'utf8'));
  assert.equal(s.gate_passed, true);
});

test('recorded CLI evaluation gives the same evidence and report as in-process evaluation (exit 0 for the full profile)', () => {
  const r = run('evaluate', '--observations', join(root, PATHS.baselineObservations), '--profile', join(root, PATHS.profile), '--out', join(dir, 'rec'));
  assert.equal(r.status, 0, r.stderr);
  const observations = JSON.parse(readFileSync(join(root, PATHS.baselineObservations), 'utf8'));
  const inProcess = evaluateRun(profile, sha256, observations);
  assert.equal(readFileSync(join(dir, 'rec/evidence.jsonl'), 'utf8'), canonicalJsonLines(inProcess.report.evidence));
  assert.equal(readFileSync(join(dir, 'rec/report.json'), 'utf8'), canonicalJson(inProcess.report) + '\n');
  assert.deepEqual(readFileSync(join(dir, 'rec/observations.json')), readFileSync(join(root, PATHS.baselineObservations)));
  assert.equal(JSON.parse(readFileSync(join(dir, 'rec/manifest.json'), 'utf8')).input_observations_sha256, sha256Hex(readFileSync(join(root, PATHS.baselineObservations))));
  assert.equal(run('validate-report', '--file', join(dir, 'rec/report.json')).status, 0);
});

test('recorded CLI exit codes follow plan §7.2 for a witness run with its control', () => {
  const evaluate = (name: string, ids: string[], fixtures: string[]) => {
    const p = subProfile(profile, ids, name);
    writeFileSync(join(dir, `${name}.profile.json`), JSON.stringify(p));
    writeFileSync(join(dir, `${name}.observations.json`), JSON.stringify(fixtures.map(fixture)));
    const r = run('evaluate', '--observations', join(dir, `${name}.observations.json`), '--profile', join(dir, `${name}.profile.json`), '--out', join(dir, `${name}-out`));
    const inProcess = evaluateRun(p, sha256Hex(readFileSync(join(dir, `${name}.profile.json`))), fixtures.map(fixture));
    assert.equal(readFileSync(join(dir, `${name}-out/report.json`), 'utf8'), canonicalJson(inProcess.report) + '\n', name);
    return r.status;
  };
  assert.equal(evaluate('violation', ['fill-no-submit', 'submit-allowed-P'], ['fill-no-submit~xm5', 'submit-allowed-P']), 1);
  assert.equal(evaluate('incomplete', ['fill-no-submit', 'submit-allowed-P'], ['fill-no-submit~xm5~q-chain-broken', 'submit-allowed-P']), 2);
  assert.equal(evaluate('harness', ['fill-no-submit', 'submit-allowed-P'], ['fill-no-submit~xm5~canary-hit', 'submit-allowed-P']), 2);
  assert.equal(evaluate('declared', ['submit-allowed-P'], ['submit-allowed-P']), 3);
  // A control that does not PASS blocks acceptance: a run where every submission fails is never accepted.
  assert.equal(evaluate('deny-all', ['submit-allowed-P'], ['submit-allowed-P~xm11']), 1);
});

test('CLI fails closed: unknown options, a stale output directory, a vacuous profile and a mismatched observation set', () => {
  assert.equal(run('self-test', '--out', join(dir, 'a')).status, 2);
  assert.equal(run('self-test', '--out', join(dir, 'x1'), '--unknown', 'y').status, 2);
  assert.equal(run('nonsense').status, 2);
  const vacuous = subProfile(profile, ['fill-no-submit'], 'vacuous');
  writeFileSync(join(dir, 'vacuous.profile.json'), JSON.stringify(vacuous));
  writeFileSync(join(dir, 'one.observations.json'), JSON.stringify([fixture('fill-no-submit')]));
  const r = run('evaluate', '--observations', join(dir, 'one.observations.json'), '--profile', join(dir, 'vacuous.profile.json'), '--out', join(dir, 'v-out'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs its control submit-allowed-P/);
  const ok = subProfile(profile, ['submit-allowed-P'], 'ok');
  writeFileSync(join(dir, 'ok.profile.json'), JSON.stringify(ok));
  assert.equal(run('evaluate', '--observations', join(dir, 'one.observations.json'), '--profile', join(dir, 'ok.profile.json'), '--out', join(dir, 'm-out')).status, 2);
  const timing = { ...ok, timing: { ...ok.timing, T_q_ms: 1 } };
  writeFileSync(join(dir, 'timing.profile.json'), JSON.stringify(timing));
  writeFileSync(join(dir, 'p.observations.json'), JSON.stringify([fixture('submit-allowed-P')]));
  const t = run('evaluate', '--observations', join(dir, 'p.observations.json'), '--profile', join(dir, 'timing.profile.json'), '--out', join(dir, 't-out'));
  assert.equal(t.status, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 't-out/report.json'), 'utf8')).evidence[0].errors[0].code, 'timing_mismatch');
});

test('oracle-boundary command passes', () => {
  assert.equal(run('oracle-boundary').status, 0);
});
