import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';
import { Observation } from '../../src/spec/revocation/model';
import { clone, effect, root } from './helpers';

const cli = join(root, 'dist/src/revocation-cli.js');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]);

const dir = mkdtempSync(join(tmpdir(), 'revocation-cli-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('CLI self-test: two independent runs are byte-identical and every SHA binding verifies', () => {
  assert.equal(run('self-test', '--out', join(dir, 'a')).status, 0);
  assert.equal(run('self-test', '--out', join(dir, 'b')).status, 0);
  const a = files(join(dir, 'a')).map(f => relative(join(dir, 'a'), f)).sort();
  assert.deepEqual(a, files(join(dir, 'b')).map(f => relative(join(dir, 'b'), f)).sort());
  for (const f of a) assert.deepEqual(readFileSync(join(dir, 'a', f)), readFileSync(join(dir, 'b', f)), f);
  const m = JSON.parse(readFileSync(join(dir, 'a/manifest.json'), 'utf8'));
  assert.equal(m.version, 'revocation-0.2.0'); assert.equal(m.input_observations_sha256, null);
  assert.equal(sha256Hex(canonicalJson(m.implementation)), m.implementation_sha256);
  for (const f of m.implementation) assert.equal(sha256Hex(readFileSync(join(root, f.path))), f.sha256, f.path);
  assert.deepEqual(m.files.map((f: { path: string }) => f.path).sort(), a.filter(f => f !== 'manifest.json'));
  for (const f of m.files) assert.equal(sha256Hex(readFileSync(join(dir, 'a', f.path))), f.sha256, f.path);
  assert.equal(m.corpus_sha256, sha256Hex(readFileSync(join(dir, 'a/corpus.jsonl'))));
  const sensitivity = JSON.parse(readFileSync(join(dir, 'a/sensitivity.json'), 'utf8'));
  assert.equal(sensitivity.gate_passed, true); assert.equal(sensitivity.faults.length, 15);
  assert(readFileSync(join(dir, 'a/summary.md'), 'utf8').includes('Has confirmed violation: false'));
});

test('CLI arguments fail closed and output directories must be fresh', () => {
  assert.equal(run('self-test', '--out', join(dir, 'a')).status, 2);
  assert.equal(run('self-test', '--out', join(dir, 'x1'), '--unknown', 'yes').status, 2);
  assert.equal(run('self-test', '--out', join(dir, 'x2'), '--out', join(dir, 'x3')).status, 2);
  assert.equal(run('evaluate', '--out', join(dir, 'x4')).status, 2);
  assert.equal(run('bogus').status, 2);
});

const base = (): Observation[] => clone(JSON.parse(readFileSync(join(dir, 'a/observations.json'), 'utf8')));
const by = (o: Observation[], id: string) => o.find(x => x.case_id === id)!;
const violation = (o: Observation[]) => { by(o, 'in-flight-before-commit').effects.push(effect(3, 'tool_commit')); };
const unassessable = (o: Observation[]) => { by(o, 'cut-before-start').decisions[1].decision = 'UNKNOWN'; };
const harnessError = (o: Observation[]) => { by(o, 'commit-before-cut').effects.push(effect(2, 'tool_commit', 'a', 'ghost')); };
const scenarios: [string, (o: Observation[]) => unknown, number, Partial<{ VIOLATION: number; UNASSESSABLE: number; HARNESS_ERROR: number; has_confirmed_violation: boolean; technically_valid: boolean }>][] = [
  ['pass', () => undefined, 0, { VIOLATION: 0, has_confirmed_violation: false, technically_valid: true }],
  ['violation', violation, 1, { VIOLATION: 1, has_confirmed_violation: true, technically_valid: true }],
  ['unassessable', unassessable, 2, { UNASSESSABLE: 1, has_confirmed_violation: false, technically_valid: false }],
  ['harness error', harnessError, 2, { HARNESS_ERROR: 1, has_confirmed_violation: false, technically_valid: false }],
  ['violation and incomplete in the same case', o => { violation(o); by(o, 'in-flight-before-commit').complete = false; }, 2, { VIOLATION: 1, has_confirmed_violation: true, technically_valid: false }],
  ['violation and unassessable in other cases', o => { violation(o); unassessable(o); }, 2, { VIOLATION: 1, UNASSESSABLE: 1, has_confirmed_violation: true }],
  ['violation and harness error in other cases', o => { violation(o); harnessError(o); }, 2, { VIOLATION: 1, HARNESS_ERROR: 1, has_confirmed_violation: true }],
  ['harness error retaining a violation in the same case', o => { violation(o); by(o, 'in-flight-before-commit').effects.push(effect(4, 'cancellation_ack', 'a', 'ghost')); }, 2, { VIOLATION: 0, HARNESS_ERROR: 1, has_confirmed_violation: true }],
  ['unassessable and harness error', o => { unassessable(o); harnessError(o); }, 2, { UNASSESSABLE: 1, HARNESS_ERROR: 1, has_confirmed_violation: false }],
];
for (const [name, mutate, exit, expect] of scenarios) {
  test(`CLI evaluate exit code: ${name} -> ${exit}`, () => {
    const o = base(); mutate(o);
    const input = join(dir, `${name.replace(/\W+/g, '-')}.json`), out = join(dir, `out-${name.replace(/\W+/g, '-')}`);
    writeFileSync(input, JSON.stringify(o.reverse()));
    const r = run('evaluate', '--observations', input, '--out', out);
    assert.equal(r.status, exit, r.stderr);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.observation_source, 'external_adapter_declared_unverified');
    for (const [k, v] of Object.entries(expect)) assert.equal(k in report.counts ? report.counts[k] : report[k], v, k);
    assert.equal(report.acceptance_passed, exit === 0);
    assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).input_observations_sha256, sha256Hex(readFileSync(input)));
    assert(readFileSync(join(out, 'summary.md'), 'utf8').includes(`Has confirmed violation: ${report.has_confirmed_violation}`));
  });
}

test('CLI evaluate rejects an observation set that does not match the corpus, without a report', () => {
  const input = join(dir, 'short.json'); writeFileSync(input, JSON.stringify(base().slice(1)));
  const r = run('evaluate', '--observations', input, '--out', join(dir, 'out-short'));
  assert.equal(r.status, 2); assert.match(r.stderr, /one observation per corpus case/);
});
