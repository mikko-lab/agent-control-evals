import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expected } from '../../src/oracle/revocation/expected';
import { observe, FAULTS } from '../../src/adapter/revocation-reference/runtime';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { faultRuns, runValid, WITNESSES, witnessHolds } from '../../src/eval/revocation/self-test';
import { MUTANTS } from '../../scripts/revocation-regressions';
import { cases, clone, effect, root } from './helpers';

const truths = cases.map(expected);
const runs = faultRuns(cases, truths);

test('sensitivity: every declared fault is killed by its fixed witness with valid, sufficient evidence', () => {
  assert.deepEqual(new Set(FAULTS), new Set(WITNESSES.map(w => w.fault)));
  assert.equal(new Set(WITNESSES.map(w => w.fault)).size, WITNESSES.length);
  for (const r of runs) { assert(r.valid, `${r.fault} run valid`); assert(r.killed, `${r.fault} killed`); }
});

test('sensitivity: witnesses do not hold on the baseline', () => {
  const baseline = cases.map((c, i) => evaluate(c, truths[i], observe(c)));
  for (const w of WITNESSES) assert(!witnessHolds(w, baseline.find(e => e.case_id === w.case_id)!), w.fault);
});

test('sensitivity: decision-only faults leave the effect channel clean; deny_with_effect leaves the decision channel clean', () => {
  const at = (fault: string) => { const r = runs.find(r => r.fault === fault)!; return r.evidence.find(e => e.case_id === r.case_id)!; };
  assert.deepEqual(at('decision_only_false_allow').effect_findings, []); assert.deepEqual(at('decision_only_false_allow').decision_findings, [{ step: 3, reason: 'false_allow' }]);
  assert.deepEqual(at('decision_only_false_deny').effect_findings, []); assert(at('decision_only_false_deny').decision_findings.some(f => f.reason === 'false_deny'));
  assert.deepEqual(at('deny_with_effect').decision_findings, []);
  assert.deepEqual(at('write_behind_commit').decision_findings, []);
  // The commit-fence policy bypass needs both channels.
  const bypass = at('commit_bypass');
  assert(bypass.decision_findings.some(f => f.reason === 'false_allow' && f.step === 3)); assert(bypass.effect_findings.some(f => f.reason === 'unexpected_tool_commit' && f.step === 3));
});

test('sensitivity: overlaps between faults are reported, not hidden', () => {
  const stale = runs.find(r => r.fault === 'stale_permit')!;
  assert(stale.also_satisfies.includes('session_start_bypass'));
  for (const r of runs) assert(!r.also_satisfies.includes(r.fault));
});

test('sensitivity: HARNESS_ERROR or incomplete evidence anywhere in a run never kills a fault', () => {
  const r = runs.find(r => r.fault === 'deny_with_effect')!;
  const i = cases.findIndex(c => c.id === 'commit-before-cut');
  const broken = clone(r.observations[i]); broken.effects.push(effect(2, 'tool_commit', 'a', 'ghost'));
  const evidence = [...r.evidence]; evidence[i] = evaluate(cases[i], truths[i], broken);
  assert.equal(evidence[i].verdict, 'HARNESS_ERROR'); assert.equal(runValid(evidence), false);
  const open = clone(r.observations[i]); open.complete = false;
  evidence[i] = evaluate(cases[i], truths[i], open); assert.equal(runValid(evidence), false);
  const witness = WITNESSES.find(w => w.fault === 'deny_with_effect')!;
  const j = cases.findIndex(c => c.id === witness.case_id);
  const leaked = clone(r.observations[j]); leaked.effects.push(effect(4, 'cancellation_ack', 'a', 'ghost'));
  assert.equal(witnessHolds(witness, evaluate(cases[j], truths[j], leaked)), false, 'a HARNESS_ERROR witness case does not hold even with retained findings');
});

test('faults act on scenario content, not on case IDs or families', () => {
  for (const fault of [undefined, ...FAULTS]) for (const c of cases) {
    const renamed = { ...clone(c), id: `renamed-${c.steps.length}`, family: 'control' as const };
    const a = observe(c, fault), b = observe(renamed, fault);
    assert.deepEqual([b.decisions, b.effects], [a.decisions, a.effects], `${fault}:${c.id}`);
  }
  const runtime = readFileSync(join(root, 'src/adapter/revocation-reference/runtime.ts'), 'utf8');
  assert(!/family/.test(runtime));
  for (const c of cases) assert(!runtime.includes(`'${c.id}'`), c.id);
});

test('terminal evidence never comes from the seal: every terminal follows a finish request of its own execution', () => {
  for (const fault of [undefined, ...FAULTS]) for (const c of cases) for (const f of observe(c, fault).effects.filter(f => f.kind === 'execution_terminal')) {
    const finish = c.steps.findIndex((s, i) => s.op === 'finish' && s.authority === f.authority && s.execution === f.execution && (i === f.step || i === f.step - 1));
    assert(finish >= 0, `${fault}:${c.id} terminal@${f.step}`);
  }
});

test('evaluator regression anchors exist exactly once in the compiled evaluator', () => {
  for (const m of MUTANTS) {
    const source = readFileSync(join(root, m.file), 'utf8');
    assert.equal(source.split(m.from).length - 1, 1, m.id);
  }
});
