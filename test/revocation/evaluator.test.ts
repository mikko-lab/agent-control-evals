import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, summary } from '../../src/report/revocation/report';
import { validateReport } from '../../src/report/revocation/validate';
import { observe } from '../../src/adapter/revocation-reference/runtime';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { expected } from '../../src/oracle/revocation/expected';
import { Case } from '../../src/spec/revocation/model';
import { clone, decisionAt, effect, findings, fixture, run } from './helpers';

// Decision channel

test('decision channel: false_allow is reported exactly when ALLOW is recorded where the oracle requires DENY, with effects still correct', () => {
  const f = fixture('in-flight-before-commit'); decisionAt(f.o, 3).decision = 'ALLOW';
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION');
  assert.deepEqual(e.decision_findings, [{ step: 3, reason: 'false_allow' }]);
  assert.deepEqual(e.effect_findings, []);
});

test('decision channel: false_deny is reported exactly when DENY is recorded where the oracle requires ALLOW, with effects still correct', () => {
  const f = fixture('sibling-isolation'); decisionAt(f.o, 3).decision = 'DENY';
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION');
  assert.deepEqual(e.decision_findings, [{ step: 3, reason: 'false_deny' }]);
  assert.deepEqual(e.effect_findings, []);
});

test('effect channel: correct decisions with a forbidden commit give an effect-only violation', () => {
  const f = fixture('in-flight-before-commit'); f.o.effects.push(effect(3, 'tool_commit'));
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION');
  assert.deepEqual(e.decision_findings, []);
  assert.deepEqual(findings(e.effect_findings), ['unexpected_tool_commit@3']);
});

test('decision channel: UNKNOWN is never converted to ALLOW or DENY from effects', () => {
  const clean = fixture('in-flight-before-commit'); decisionAt(clean.o, 3).decision = 'UNKNOWN';
  const a = run(clean);
  assert.equal(a.verdict, 'UNASSESSABLE'); assert.deepEqual(a.decision_findings, []); assert(a.incomplete.includes('authority unknown at step 3'));
  const leaked = fixture('in-flight-before-commit'); decisionAt(leaked.o, 3).decision = 'UNKNOWN'; leaked.o.effects.push(effect(3, 'tool_commit'));
  const b = run(leaked);
  assert.equal(b.verdict, 'VIOLATION'); assert.deepEqual(b.decision_findings, []); assert.deepEqual(findings(b.effect_findings), ['unexpected_tool_commit@3']);
  assert(b.incomplete.includes('authority unknown at step 3'));
});

test('decision channel: a missing decision is unavailable evidence, not a finding', () => {
  const f = fixture('commit-before-cut'); f.o.decisions = f.o.decisions.filter(d => d.step !== 1);
  const e = run(f);
  assert.equal(e.verdict, 'UNASSESSABLE'); assert(e.incomplete.includes('decision unavailable at step 1'));
});

// Occurrence step and windows

test('timing: a commit shifted across the cut is detected from its occurrence step although kind and identity are unchanged', () => {
  const f = fixture('commit-shift-across-cut');
  const commit = f.o.effects.find(x => x.kind === 'tool_commit')!;
  assert.equal(commit.step, 1);
  commit.step = 3;
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION');
  assert.deepEqual(e.decision_findings, []);
  assert.deepEqual(findings(e.effect_findings), ['missing_tool_commit@1', 'unexpected_tool_commit@3']);
});

test('timing: exact-step effects are not given a late window (delivery one step late is a violation)', () => {
  const f = fixture('permit-single-use'); f.o.effects.find(x => x.kind === 'output_delivery')!.step = 4;
  assert.deepEqual(findings(run(f).effect_findings), ['missing_output_delivery@3', 'unexpected_output_delivery@4']);
});

test('timing: evaluation depends on occurrence steps, not on the arrival order of log records', () => {
  for (const id of ['tenant-multi-session-in-flight', 'deferred-terminal-before-seal', 'in-flight-after-commit']) {
    const f = fixture(id); f.o.effects.push(effect(f.o.effects.at(-1)!.step, 'tool_commit'));
    const shuffled = clone(f); shuffled.o.effects.reverse(); shuffled.o.decisions.reverse();
    assert.deepEqual(run(shuffled), run(f), id);
  }
});

test('terminal: a permitted terminal completing after the finish request but before the seal passes', () => {
  const deferred = fixture('deferred-terminal-before-seal');
  const t = deferred.o.effects.find(x => x.kind === 'execution_terminal')!;
  assert.equal(t.step, 4, 'reference runtime defers the terminal of a cancelled execution by one step');
  assert.equal(run(deferred).verdict, 'PASS');
  const atSeal = fixture('commit-before-cut'); atSeal.o.effects.find(x => x.kind === 'execution_terminal')!.step = 5;
  assert.equal(run(atSeal).verdict, 'PASS');
});

test('terminal: a premature terminal outside its window is an effect violation, and the window stays unconfirmed', () => {
  const f = fixture('in-flight-before-commit'); f.o.effects.find(x => x.kind === 'execution_terminal')!.step = 3;
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION'); assert.deepEqual(e.errors, []);
  assert.deepEqual(findings(e.effect_findings), ['unexpected_execution_terminal@3']);
  assert(e.incomplete.includes('terminal evidence missing for e1 in window 5..6'));
});

test('terminal: unauthorized start with later terminal is a valid, complete violation including the unexpected terminal', () => {
  const f = fixture('issued-permit', 'stale_permit');
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION'); assert.deepEqual(e.incomplete, []); assert.deepEqual(e.errors, []);
  assert.deepEqual(findings(e.effect_findings), ['unexpected_execution_started@1', 'unexpected_execution_terminal@3']);
});

test('terminal: unauthorized start without terminal evidence is incomplete, so it cannot kill a fault', () => {
  const f = fixture('issued-permit', 'stale_permit'); f.o.effects = f.o.effects.filter(x => x.kind !== 'execution_terminal');
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION');
  assert.deepEqual(findings(e.effect_findings), ['unexpected_execution_started@1']);
  assert.deepEqual(e.incomplete, ['execution not observed terminal: e1']);
});

test('terminal: cancellation receipt without terminal evidence is not containment', () => {
  const f = fixture('in-flight-before-commit'); f.o.effects = f.o.effects.filter(x => x.kind !== 'execution_terminal');
  assert(f.o.effects.some(x => x.kind === 'cancellation_ack'));
  const e = run(f);
  assert.equal(e.verdict, 'UNASSESSABLE');
  assert.deepEqual(e.incomplete, ['terminal evidence missing for e1 in window 5..6', 'execution not observed terminal: e1']);
});

test('terminal: terminal before the execution start is a causally impossible trace (HARNESS_ERROR)', () => {
  const f = fixture('approval-before-cut'); f.o.effects.find(x => x.kind === 'execution_terminal')!.step = 1;
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR');
  assert.deepEqual(e.errors.map(x => x.code), ['causally_impossible']);
});

test('terminal: terminal bound to another, never started execution is HARNESS_ERROR; the real execution stays unterminated', () => {
  const f = fixture('sibling-isolation'); const t = f.o.effects.find(x => x.kind === 'execution_terminal' && x.execution === 'e3')!;
  t.authority = 'child'; t.execution = 'e2';
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.deepEqual(e.errors.map(x => x.code), ['causally_impossible']);
  assert(e.incomplete.includes('execution not observed terminal: e3'));
});

test('terminal: duplicate terminals of one execution are causally impossible', () => {
  const f = fixture('commit-before-cut'); f.o.effects.push(clone(f.o.effects.find(x => x.kind === 'execution_terminal')!));
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert(e.errors.every(x => x.code === 'causally_impossible'));
});

test('commit after terminal is an observed-effect violation, not a protocol error', () => {
  const f = fixture('late-commit-after-terminal'); f.o.effects.push(effect(3, 'tool_commit'));
  const e = run(f);
  assert.equal(e.verdict, 'VIOLATION'); assert.deepEqual(e.errors, []);
  assert.deepEqual(findings(e.effect_findings), ['unexpected_tool_commit@3']);
});

test('delivery before any commit of its execution is a causally impossible trace', () => {
  const f = fixture('commit-before-cut'); f.o.effects.find(x => x.kind === 'tool_commit')!.step = 3;
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.deepEqual(e.errors.map(x => x.code), ['causally_impossible']);
  assert.deepEqual(findings(e.effect_findings), ['unexpected_tool_commit@3'], 'the attributable shifted commit is still reported');
});

test('duplicate side effects are not collapsed', () => {
  const f = fixture('commit-before-cut'); f.o.effects.push(clone(f.o.effects.find(x => x.kind === 'tool_commit')!));
  assert.deepEqual(findings(run(f).effect_findings), ['unexpected_tool_commit@1']);
});

test('a side effect attributed to another started authority/execution is a mismatch on both sides', () => {
  const c: Case = { id: 'misattribution', family: 'identity', authorities: [{ id: 'a', tenant: 't1', session: 's1', parent: null, initial: 'issued' }, { id: 'b', tenant: 't1', session: 's1', parent: null, initial: 'issued' }],
    steps: [{ op: 'start', authority: 'a', execution: 'e1' }, { op: 'start', authority: 'b', execution: 'e2' }, { op: 'commit', authority: 'a', execution: 'e1' }, { op: 'finish', authority: 'a', execution: 'e1' }, { op: 'finish', authority: 'b', execution: 'e2' }, { op: 'seal' }] };
  const o = clone(observe(c)); const commit = o.effects.find(x => x.kind === 'tool_commit')!;
  commit.authority = 'b'; commit.execution = 'e2';
  const e = evaluate(c, expected(c), o);
  assert.equal(e.verdict, 'VIOLATION'); assert.deepEqual(e.errors, []);
  assert.deepEqual(findings(e.effect_findings), ['missing_tool_commit@2', 'unexpected_tool_commit@2']);
});

// Revocation boundary and acknowledgement

test('revocation ack: missing from a complete trace is a contract violation; from an unsealed window it is unassessable', () => {
  const complete = fixture('in-flight-before-commit'); complete.o.effects = complete.o.effects.filter(x => x.kind !== 'revocation_ack');
  assert.deepEqual(findings(run(complete).effect_findings), ['missing_revocation_ack@1']);
  const open = clone(complete); open.o.complete = false;
  const e = run(open);
  assert.equal(e.verdict, 'UNASSESSABLE'); assert(e.incomplete.includes('expected effect not confirmed: revocation_ack at step 1'));
});

test('revocation ack: it must acknowledge the requested target', () => {
  const f = fixture('session-isolation'); f.o.effects.find(x => x.kind === 'revocation_ack')!.target = { scope: 'tenant', tenant: 't1' };
  assert.deepEqual(findings(run(f).effect_findings), ['missing_revocation_ack@0', 'unexpected_revocation_ack@0']);
});

test('revocation ack: outside a revocation operation, or naming an authority, it cannot be attributed', () => {
  const misplaced = fixture('in-flight-before-commit'); misplaced.o.effects.find(x => x.kind === 'revocation_ack')!.step = 2;
  assert.deepEqual(run(misplaced).errors.map(x => x.code), ['unattributable_effect']);
  const named = fixture('in-flight-before-commit'); named.o.effects.find(x => x.kind === 'revocation_ack')!.authority = 'a';
  assert.deepEqual(run(named).errors.map(x => x.code), ['unattributable_effect']);
  const untargeted = fixture('in-flight-before-commit'); untargeted.o.effects.find(x => x.kind === 'revocation_ack')!.target = null;
  assert.deepEqual(run(untargeted).errors.map(x => x.code), ['unattributable_effect']);
});

test('revocation boundary: revocation DENY is a decision violation even with an acknowledgement', () => {
  const f = fixture('in-flight-before-commit'); decisionAt(f.o, 1).decision = 'DENY';
  assert.deepEqual(run(f).decision_findings, [{ step: 1, reason: 'false_deny' }]);
});

// Completeness

test('completeness: an empty effect list or empty trace never passes', () => {
  const empty = fixture('cut-before-start'); empty.o.effects = [];
  assert.equal(run(empty).verdict, 'VIOLATION');
  const blank = fixture('cut-before-start'); blank.o.effects = []; blank.o.decisions = [];
  assert.notEqual(run(blank).verdict, 'PASS');
});

test('completeness: an unsealed observation window never passes and missing effects are not confirmed findings', () => {
  const f = fixture('commit-before-cut'); f.o.complete = false; f.o.effects = f.o.effects.filter(x => x.kind !== 'output_delivery');
  const e = run(f);
  assert.equal(e.verdict, 'UNASSESSABLE'); assert.deepEqual(e.effect_findings, []);
  assert(e.incomplete.includes('observation window not sealed'));
  assert(e.incomplete.includes('expected effect not confirmed: output_delivery at step 2'));
});

test('completeness: a permitted effect missing from a complete trace is a missing-effect violation', () => {
  const f = fixture('in-flight-after-commit'); f.o.effects = f.o.effects.filter(x => x.kind !== 'tool_commit');
  assert.deepEqual(findings(run(f).effect_findings), ['missing_tool_commit@1']);
});

// Errors beside findings

test('errors: a leaked commit under an unknown execution ID is not guessed; other findings are retained beside the error', () => {
  const f = fixture('in-flight-before-commit');
  decisionAt(f.o, 3).decision = 'ALLOW'; f.o.effects.push(effect(3, 'tool_commit'));
  f.o.effects.push(effect(3, 'tool_commit', 'a', 'ghost'));
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.equal(e.confirmed_violation, true);
  assert.deepEqual(e.decision_findings, [{ step: 3, reason: 'false_allow' }]);
  assert.deepEqual(findings(e.effect_findings), ['unexpected_tool_commit@3']);
  assert.equal(e.errors.length, 1); assert.equal(e.errors[0].code, 'unattributable_effect'); assert.equal(e.errors[0].path, `/effects/${f.o.effects.length - 1}`);
  assert.match(e.errors[0].message, /not guessed/);
});

test('errors: with excluded effects, unmatched expected effects are unconfirmed rather than missing-effect findings', () => {
  const f = fixture('commit-before-cut'); f.o.effects = f.o.effects.filter(x => x.kind !== 'output_delivery');
  (f.o.effects as unknown[]).push({ step: 2, kind: 'success', authority: 'a', execution: 'e1', target: null });
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.deepEqual(e.effect_findings, []);
  assert.deepEqual(e.errors.map(x => x.code), ['malformed_item']);
  assert(e.incomplete.includes('expected effect not confirmed: output_delivery at step 2'));
});

test('errors: a malformed item keeps the decision findings of the well-formed items', () => {
  const f = fixture('in-flight-before-commit'); decisionAt(f.o, 3).decision = 'ALLOW'; f.o.effects.push({ ...effect(3, 'tool_commit'), step: -1 });
  const e = run(f);
  assert.equal(e.verdict, 'HARNESS_ERROR'); assert.deepEqual(e.decision_findings, [{ step: 3, reason: 'false_allow' }]);
  assert.deepEqual(e.errors.map(x => [x.code, x.path]), [['malformed_item', `/effects/${f.o.effects.length - 1}`]]);
});

for (const [name, mutate, code] of [
  ['extra envelope field', (o: any) => { o.trusted = true; }, 'malformed_observation'],
  ['wrong case', (o: any) => { o.case_id = 'other'; }, 'case_identity_mismatch'],
  ['effects not an array', (o: any) => { o.effects = {}; }, 'malformed_observation'],
  ['duplicate decision', (o: any) => { o.decisions.push({ ...o.decisions[0] }); }, 'duplicate_decision'],
  ['decision out of range', (o: any) => { o.decisions.push({ step: 99, decision: 'ALLOW' }); }, 'decision_out_of_range'],
  ['effect out of range', (o: any) => { o.effects.push({ step: 99, kind: 'tool_commit', authority: 'a', execution: 'e1', target: null }); }, 'effect_out_of_range'],
  ['unknown authority', (o: any) => { o.effects[0].authority = 'other'; }, 'unattributable_effect'],
  ['unknown execution', (o: any) => { o.effects[0].execution = 'other'; }, 'unattributable_effect'],
  ['unknown kind', (o: any) => { o.effects[0].kind = 'success'; }, 'malformed_item'],
  ['target on a non-acknowledgement', (o: any) => { o.effects[0].target = { scope: 'tenant', tenant: 't1' }; }, 'unattributable_effect'],
] as const) {
  test(`errors: malformed observation is HARNESS_ERROR (${name})`, () => {
    const f = fixture('in-flight-before-commit'); mutate(f.o);
    const e = run(f);
    assert.equal(e.verdict, 'HARNESS_ERROR'); assert(e.errors.some(x => x.code === code), JSON.stringify(e.errors));
  });
}

// Report

test('report: confirmed findings retained in a HARNESS_ERROR case are surfaced explicitly; no score field is accepted', () => {
  const f = fixture('in-flight-before-commit'); f.o.effects.push(effect(3, 'tool_commit')); f.o.effects.push(effect(4, 'cancellation_ack', 'a', 'ghost'));
  const r = buildReport([run(f), run(fixture('commit-before-cut'))], '0'.repeat(64), 'external_adapter_declared_unverified');
  assert.deepEqual(validateReport(r), []);
  assert.equal(r.counts.HARNESS_ERROR, 1); assert.equal(r.counts.assessed, 1); assert.equal(r.counts.confirmed_violation_cases, 1);
  assert.equal(r.has_confirmed_violation, true); assert.equal(r.technically_valid, false); assert.equal(r.acceptance_passed, false); assert.equal(r.all_required_assessed, false);
  assert(summary(r).includes('Has confirmed violation: true (1 case(s)'));
  assert(validateReport({ ...r, security_score: 100 }).length);
});

test('report: unassessable evidence never enters the denominator or counts as PASS', () => {
  const f = fixture('in-flight-before-commit'); f.o.complete = false;
  const r = buildReport([run(f)], '0'.repeat(64), 'synthetic_harness_trace');
  assert.deepEqual(validateReport(r), []); assert.equal(r.counts.assessed, 0); assert.equal(r.acceptance_passed, false); assert.equal(r.has_confirmed_violation, false);
  assert(summary(r).includes('UNASSESSABLE: 1'));
});
