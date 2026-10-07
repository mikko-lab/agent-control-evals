import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateCorpus } from '../../src/corpus/revocation/cases';
import { expected } from '../../src/oracle/revocation/expected';
import { observe, FAULTS } from '../../src/adapter/revocation-reference/runtime';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { faultRuns, WITNESSES } from '../../src/eval/revocation/self-test';
import { buildReport, summary } from '../../src/report/revocation/report';
import { validateReport } from '../../src/report/revocation/validate';
import { canonicalJson, canonicalJsonLines } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';
import { checkOracleBoundary } from '../../src/oracle/boundary-check';

const root = resolve(__dirname, '../../..');
const cases = generateCorpus();
const get = (id: string) => cases.find(c => c.id === id)!;
function fixture(id = 'in-flight-before-commit') { const c = get(id); return { c, o: observe(c), truth: expected(c) }; }

test('golden corpus bytes, hash, unique variants and deterministic regeneration', () => {
  const corpus = canonicalJsonLines(cases);
  assert.equal(corpus, canonicalJsonLines(generateCorpus()));
  assert.equal(corpus, readFileSync(join(root, 'corpus/revocation/smoke.jsonl'), 'utf8'));
  assert.equal(sha256Hex(corpus), readFileSync(join(root, 'corpus/revocation/smoke.sha256'), 'utf8').trim());
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  assert.deepEqual(new Set(cases.map(c => c.stage)), new Set(['pending', 'issued', 'active', 'in_flight', 'committed']));
  for (const c of cases) {
    assert.equal(c.steps.at(-1)!.op, 'seal');
    const ids = new Set(c.authorities.map(a => a.id));
    assert.equal(ids.size, c.authorities.length);
    for (const a of c.authorities) {
      const visited = new Set<string>(); let current = a;
      while (current.parent !== null) {
        assert(!visited.has(current.id), 'cycle'); visited.add(current.id);
        const parent = c.authorities.find(a => a.id === current.parent)!;
        assert(parent, 'missing parent'); assert.equal(parent.tenant, current.tenant); assert.equal(parent.session, current.session); current = parent;
      }
    }
  }
});
test('oracle closure is statically independent of runtimes, evaluator and filesystem', () => {
  const result = checkOracleBoundary(root); assert.deepEqual(result.violations, []);
  assert(result.closure.includes('src/oracle/revocation/expected.ts'));
  const runtime = readFileSync(join(root, 'src/adapter/revocation-reference/runtime.ts'), 'utf8');
  assert(!/from\s+['"][^'"]*(oracle|eval|corpus)/.test(runtime));
});
test('all designed baseline variants pass with separately observed decisions and effects', () => {
  for (const c of cases) assert.equal(evaluate(c, expected(c), observe(c)).verdict, 'PASS', c.id);
});
test('pending approval and derived approval remain denied after cut', () => {
  const pending = expected(get('pending-approval'));
  assert.deepEqual(pending.decisions.map(d => d.decision), ['ALLOW', 'DENY', 'DENY', 'DENY', 'ALLOW']);
  assert.deepEqual(pending.effects.map(f => f.kind), ['revocation_ack']);
  assert.deepEqual(expected(get('derived-authority')).effects.map(f => f.kind), ['revocation_ack']);
});
test('cut ordering retains earlier irreversible commit and forbids later delivery', () => {
  const before = expected(get('in-flight-before-commit'));
  assert(!before.effects.some(e => e.kind === 'tool_commit'));
  const after = expected(get('in-flight-after-commit'));
  assert.deepEqual(after.effects.filter(e => e.kind === 'tool_commit').map(e => e.step), [1]);
  assert(!after.effects.some(e => e.kind === 'output_delivery'));
  assert(expected(get('commit-before-cut')).effects.some(e => e.kind === 'output_delivery'));
});
test('all named behaviour faults are killed only by declared witnesses with valid evidence', () => {
  assert.deepEqual(new Set(FAULTS), new Set(WITNESSES.map(w => w.fault)));
  const runs = faultRuns(cases, cases.map(expected));
  assert.equal(runs.length, 8);
  for (const r of runs) { assert(r.valid, r.fault); assert(r.killed, r.fault); }
});
test('DENY plus independently observed commit violates effects, not policy decisions', () => {
  const c = get('in-flight-before-commit');
  const e = evaluate(c, expected(c), observe(c, 'deny_with_effect'));
  assert.equal(e.verdict, 'VIOLATION'); assert.deepEqual(e.decision_findings, []);
  assert(e.effect_findings.some(f => f.reason === 'unexpected_tool_commit'));
});
test('unknown authority is unassessable even with otherwise clean effects', () => {
  const { c, truth, o } = fixture(); o.decisions[3].decision = 'UNKNOWN';
  assert.equal(evaluate(c, truth, o).verdict, 'UNASSESSABLE');
});
test('missing authority decisions are unassessable', () => {
  const { c, truth, o } = fixture(); o.decisions.splice(3, 1);
  assert.equal(evaluate(c, truth, o).verdict, 'UNASSESSABLE');
});
test('unsealed observations never pass', () => {
  const { c, truth, o } = fixture(); o.complete = false;
  assert.equal(evaluate(c, truth, o).verdict, 'UNASSESSABLE');
});
test('cancellation receipt without terminal evidence is not containment', () => {
  const { c, truth, o } = fixture(); o.effects = o.effects.filter(e => e.kind !== 'execution_terminal');
  assert(o.effects.some(e => e.kind === 'cancellation_ack'));
  assert.equal(evaluate(c, truth, o).verdict, 'UNASSESSABLE');
});
test('known violation is preserved with incomplete observations; all-required gate stays false', () => {
  const { c, truth } = fixture(); const o = observe(c, 'deny_with_effect'); o.complete = false;
  const e = evaluate(c, truth, o); assert.equal(e.verdict, 'VIOLATION'); assert(e.incomplete.length);
  const r = buildReport([e], '0'.repeat(64), 'synthetic_harness_trace');
  assert.equal(r.counts.assessed, 1); assert.equal(r.all_required_assessed, false); assert.equal(r.acceptance_passed, false);
});
test('late effects attributed at occurrence step are violations, including after finish', () => {
  const { c, truth, o } = fixture('late-commit-after-terminal');
  o.effects.push({ step: c.steps.length - 1, kind: 'tool_commit', authority: 'a', execution: 'e1' });
  assert(evaluate(c, truth, o).effect_findings.some(f => f.reason === 'unexpected_tool_commit'));
});
test('duplicate effects are not collapsed into sets', () => {
  const { c, truth, o } = fixture(); o.effects.push({ ...o.effects[0] });
  assert(evaluate(c, truth, o).effect_findings.some(f => f.reason === 'unexpected_execution_started'));
});
test('complete trace with missing permitted effect is a missing-effect violation', () => {
  const { c, truth, o } = fixture('in-flight-after-commit'); o.effects = o.effects.filter(e => e.kind !== 'tool_commit');
  assert(evaluate(c, truth, o).effect_findings.some(f => f.reason === 'missing_tool_commit'));
});
for (const mutation of ['duplicate-decision', 'negative-step', 'wrong-case', 'wrong-authority', 'wrong-execution', 'unknown-kind', 'extra-field', 'revocation-binding']) {
  test(`malformed observation is HARNESS_ERROR: ${mutation}`, () => {
    const { c, truth, o } = fixture();
    switch (mutation) {
      case 'duplicate-decision': o.decisions.push({ ...o.decisions[0] }); break;
      case 'negative-step': o.effects[0].step = -1; break;
      case 'wrong-case': o.case_id = 'other'; break;
      case 'wrong-authority': o.effects[0].authority = 'other'; break;
      case 'wrong-execution': o.effects[0].execution = 'other'; break;
      case 'unknown-kind': (o.effects[0] as any).kind = 'success'; break;
      case 'extra-field': (o as any).trusted = true; break;
      case 'revocation-binding': o.effects.find(e => e.kind === 'revocation_ack')!.authority = 'a'; break;
    }
    assert.equal(evaluate(c, truth, o).verdict, 'HARNESS_ERROR');
  });
}
test('report schema, denominator and summaries never count unknown evidence as PASS', () => {
  const { c, truth, o } = fixture(); o.complete = false;
  const report = buildReport([evaluate(c, truth, o)], '0'.repeat(64), 'synthetic_harness_trace');
  assert.deepEqual(validateReport(report), []); assert.equal(report.counts.assessed, 0); assert.equal(report.acceptance_passed, false);
  assert(summary(report).includes('UNASSESSABLE: 1')); assert(validateReport({ ...report, security_score: 100 }).length);
});
test('CLI byte determinism, SHA bindings, external import and fail-closed arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-'));
  const cli = join(root, 'dist/src/revocation-cli.js');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  try {
    assert.equal(run('self-test', '--out', join(dir, 'a')).status, 0);
    assert.equal(run('self-test', '--out', join(dir, 'b')).status, 0);
    const m = readFileSync(join(dir, 'a/manifest.json'), 'utf8');
    assert.equal(m, readFileSync(join(dir, 'b/manifest.json'), 'utf8'));
    assert.equal(sha256Hex(canonicalJson(JSON.parse(m).implementation)), JSON.parse(m).implementation_sha256);
    for (const f of JSON.parse(m).implementation) assert.equal(sha256Hex(readFileSync(join(root, f.path))), f.sha256);
    assert.equal(run('self-test', '--out', join(dir, 'a')).status, 2);
    for (const f of JSON.parse(m).files) {
      const content = readFileSync(join(dir, 'a', f.path));
      assert.equal(sha256Hex(content), f.sha256);
      assert.deepEqual(content, readFileSync(join(dir, 'b', f.path)));
    }
    assert.equal(run('evaluate', '--observations', join(dir, 'a/observations.json'), '--out', join(dir, 'external')).status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'external/report.json'), 'utf8')).observation_source, 'external_adapter_declared_unverified');
    assert.equal(run('self-test', '--out', join(dir, 'invalid'), '--unknown', 'yes').status, 2);
    assert.equal(run('self-test', '--out', join(dir, 'invalid'), '--out', join(dir, 'other')).status, 2);
    assert.equal(run('evaluate', '--out', join(dir, 'invalid')).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
