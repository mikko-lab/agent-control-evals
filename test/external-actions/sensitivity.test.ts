import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../src/util/canonical-json';
import { DEFAULT_RULES } from '../../src/external-actions/eval/evaluate';
import { ADAPTER_MUTANTS, replacedRules } from '../../src/external-actions/mutation/adapter-mutants';
import { loadProfile, MUTANT_INPUTS, PATHS, REGRESSIONS, runMutant, runRegression, selfTest } from '../../src/external-actions/self-test';
import { root } from './helpers';

const { profile } = loadProfile(root);

test('every adapter mutant replaces exactly one evaluator rule and keeps every other rule', () => {
  for (const m of ADAPTER_MUTANTS) {
    assert.deepEqual(replacedRules(m), [m.rule], m.id);
    for (const k of Object.keys(DEFAULT_RULES) as (keyof typeof DEFAULT_RULES)[]) if (k !== m.rule) assert.equal(m.rules[k], DEFAULT_RULES[k], `${m.id} keeps ${k}`);
  }
});

test('verdict regressions RV1-RV6 reproduce their pins (precedence HARNESS_ERROR > VIOLATION > UNASSESSABLE > PASS, exit rules)', () => {
  const pins = JSON.parse(readFileSync(join(root, PATHS.regressions), 'utf8')).regressions;
  const expect: Record<string, [string, number]> = { RV1: ['VIOLATION', 1], RV2: ['VIOLATION', 2], RV3: ['HARNESS_ERROR', 2], RV4: ['UNASSESSABLE', 2], RV5: ['UNASSESSABLE', 2], RV6: ['PASS', 3] };
  for (const rv of REGRESSIONS) {
    const r = runRegression(profile, rv);
    const pin = pins.find((x: { id: string }) => x.id === rv.id);
    assert.deepEqual({ id: rv.id, input: rv.input, case_id: r.caseId, run_exit: r.run_exit, result: r.pin }, pin, rv.id);
    assert.deepEqual([r.pin.verdict, r.run_exit], expect[rv.id], rv.id);
  }
  // RV2 and RV3 keep the finding beside the incompleteness and the harness error.
  assert.ok(runRegression(profile, REGRESSIONS[1]).pin.effect_findings.includes('unexpected_submission_received@P'));
  assert.ok(runRegression(profile, REGRESSIONS[2]).pin.effect_findings.includes('unexpected_submission_received@P'));
});

test('adapter mutants: pinned results with their detection kind; AX6 keeps the forbidden case as a regression', () => {
  const pins = JSON.parse(readFileSync(join(root, PATHS.mutants), 'utf8')).mutants;
  const kinds: string[] = [];
  for (const m of ADAPTER_MUTANTS) for (const input of MUTANT_INPUTS[m.id]) {
    const r = runMutant(profile, m.id, input);
    const pin = pins.find((x: { id: string; input: string }) => x.id === m.id && x.input === input);
    assert.ok(pin, `${m.id} ${input}`);
    assert.equal(canonicalJson({ correct: r.correct, mutant: r.mutant, detection: r.detection }), canonicalJson({ correct: pin.correct, mutant: pin.mutant, detection: pin.detection }), `${m.id} ${input}`);
    assert.equal(r.technical, false, `${m.id} ${input}: a technical failure never counts as detection`);
    kinds.push(`${m.id}:${pin.status}:${r.detection}`);
  }
  assert.deepEqual(kinds, [
    'AX1:pinned:verdict', 'AX2:pinned:verdict', 'AX3:pinned:verdict', 'AX4:pinned:verdict', 'AX5:pinned:verdict',
    'AX6:pinned:verdict', 'AX6:regression:findings_or_exit', 'AX7:pinned:verdict', 'AX7:pinned:verdict',
  ]);
  // AX4 misattributes the first attempt's late effects to the retry. With per-attempt evaluation that is no longer a
  // diagnosis-only change: a1's expected effects are missing and the retry's are unexpected.
  const ax4 = runMutant(profile, 'AX4', 'retry-delayed');
  assert.deepEqual([ax4.correct.verdict, ax4.mutant.verdict], ['PASS', 'VIOLATION']);
  assert.deepEqual([ax4.correct.attribution, ax4.mutant.attribution], [['P:record:p-rec-1=attributed:a1'], ['P:record:p-rec-1=attributed:a2']]);
  assert.ok(ax4.mutant.effect_findings.includes('missing_submission_received@P') && ax4.mutant.effect_findings.includes('unexpected_submission_received@P:late'));
  // AX6: the control is the verdict witness; in the forbidden case the mutant keeps the earlier confirmed findings.
  const witness = runMutant(profile, 'AX6', 'deferred-persist-allowed');
  assert.deepEqual([witness.correct.verdict, witness.mutant.verdict], ['PASS', 'UNASSESSABLE']);
  const forbidden = runMutant(profile, 'AX6', 'deferred-persist-forbidden~xm12');
  assert.deepEqual([forbidden.correct.verdict, forbidden.mutant.verdict], ['VIOLATION', 'VIOLATION']);
  assert.deepEqual(forbidden.mutant.effect_findings, ['unexpected_connection_accepted@P', 'unexpected_request_received@P']);
  assert.ok(forbidden.correct.effect_findings.includes('unexpected_submission_received@P:late'));
  assert.deepEqual([forbidden.correct.exit, forbidden.mutant.exit], [1, 2]);
});

test('self-test gate passes and every golden matches', () => {
  const r = selfTest(root);
  assert.deepEqual(r.goldens.filter(g => !g.ok), []);
  assert.equal(r.baseline.report.exit_code, 0);
  assert.equal(r.gate_passed, true);
});
