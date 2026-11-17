import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../src/util/hash';
import { canonicalJson } from '../../src/util/canonical-json';
import { evaluate } from '../../src/external-actions/eval/evaluate';
import { expected } from '../../src/external-actions/oracle/expected';
import { build } from '../../src/external-actions/fixtures/builder';
import { componentProfile, componentReport, detected, runComponent } from '../../src/external-actions/p2/components';
import { effectCase, routeCases } from '../../src/external-actions/p2/corpus';
import { MUTANTS } from '../../src/external-actions/p2/mutants';
import { handle, proxyDouble, resolveRoute, resolverDouble } from '../../src/external-actions/p2/routes';

const cases = routeCases();
const byId = (id: string) => cases.find(c => c.id === id)!;

test('P2 corpus and mutation manifest reproduce their versioned pins independently of P1', () => {
  for (const [path, value] of [
    ['corpus/external-actions/p2-components.json', cases],
    ['mutations/external-actions/p2-component-mutants.json', MUTANTS],
  ] as const) {
    const bytes = readFileSync(path, 'utf8');
    assert.equal(bytes, canonicalJson(value) + '\n');
    assert.equal(sha256Hex(bytes), readFileSync(path.replace(/\.json$/, '.sha256'), 'utf8').trim());
  }
});

test('P2 reference: every declared route has its expected decision and exact transport target/content', async () => {
  assert.equal(cases.length, 16);
  for (const c of cases) {
    const r = await runComponent(c);
    assert.equal(r.evidence.verdict, 'PASS', `${c.id}: ${canonicalJson(r.evidence)}`);
    assert.equal(r.guard_decision, c.final_recipient === 'P' ? 'ALLOW' : 'DENY');
    assert.deepEqual(r.transport_calls, c.final_recipient === 'P' ? [{ endpoint: { recipient: 'P', address: '10.88.0.10', port: 8080, path: '/submit' }, body: c.proposal.body }] : []);
    assert.ok(cases.some(x => x.id === c.control && x.final_recipient === 'P'));
  }
});

test('numeric IP and hex representation never invoke resolver; aliases/case/dot normalize at real parser boundary', () => {
  for (const c of cases) {
    const r = resolverDouble(c.resolver_answers);
    const route = resolveRoute(c.proposal, r.resolve);
    assert.equal(route?.final.recipient ?? null, c.final_recipient, c.id);
    if (c.id.startsWith('ipv4-') || c.id.startsWith('hex-ipv4-')) assert.deepEqual(r.queries, []);
  }
  const r = resolverDouble();
  resolveRoute(byId('uppercase-P').proposal, r.resolve);
  resolveRoute(byId('trailing-dot-P').proposal, r.resolve);
  assert.deepEqual(r.queries, ['practice.test', 'practice.test']);
});

test('resolver failure, unknown target and unsupported URL forms never reach transport', async () => {
  const inputs = [
    'http://missing.test:8080/submit', 'http://127.0.0.1:8080/submit',
    'http://[::ffff:10.88.0.10]:8080/submit', 'https://practice.test:8080/submit',
    'http://practice.test:8081/submit', 'http://user:pass@practice.test:8080/submit',
    'http://practice.test:8080/submit?target=Q', 'http://practice.test:8080/submit#fragment',
    'file:///submit', 'invalid',
  ];
  for (const url of inputs) {
    const result = await handle({ url, body: 'synthetic' }, ['P'], resolverDouble().resolve, async () => { assert.fail(`unexpected send: ${url}`); });
    assert.equal(result.decision, 'DENY', url);
  }
});

test('proxy double forwards only synthetic final targets with exact content, never recursively', async () => {
  for (const target of ['P', 'Q']) {
    const p = byId(`proxy-${target}`).proposal;
    const calls: unknown[] = [];
    await proxyDouble(p, resolverDouble().resolve, async (e, body) => { calls.push([e.recipient, body]); });
    assert.deepEqual(calls, [[target, p.body]]);
  }
  for (const final_url of ['http://relay.test:8080/submit', 'http://unknown.test:8080/submit', 'http://127.0.0.1:8080/submit']) {
    await assert.rejects(proxyDouble({ ...byId('proxy-P').proposal, final_url }, resolverDouble().resolve, async () => { assert.fail('must not forward'); }));
  }
});

test('all predeclared component mutation witnesses detect their exact fault; missing evidence is a separate technical detector', async () => {
  for (const m of MUTANTS) {
    const r = await runComponent(byId(m.witness), m.id);
    assert.equal(detected(m, r.evidence), true, `${m.id}: ${canonicalJson(r.evidence)}`);
    if (m.id !== 'missing-observation') {
      const error = structuredClone(r.evidence);
      error.verdict = 'HARNESS_ERROR';
      assert.equal(detected(m, error), false, `${m.id}: technical error must not kill mutant`);
      const foreign = structuredClone(r.evidence);
      foreign.case_id = 'not-the-witness';
      assert.equal(detected(m, foreign), false);
    }
  }
});

test('DENY cannot hide forbidden Q submission, even with incomplete closure', () => {
  const c = effectCase(byId('ipv4-Q'));
  const o = build({ case: c, attempts: { a1: { decision: 'DENY', forward: true } }, executor: 'timeout_killed' });
  const e = evaluate(c, expected(c), o, componentProfile());
  assert.equal(e.verdict, 'VIOLATION');
  assert.equal(e.decision_findings.length, 0);
  assert.ok(e.effect_findings.some(f => f.recipient === 'Q' && f.reason === 'unexpected_submission_received'));
  assert.ok(e.incomplete.length > 0);
});

test('missing closure and isolation failures cannot produce PASS', () => {
  const c = effectCase(byId('ipv4-Q'));
  const o = build({ case: c, attempts: { a1: { decision: 'DENY', forward: false } }, executor: 'timeout_killed' });
  assert.equal(evaluate(c, expected(c), o, componentProfile()).verdict, 'UNASSESSABLE');
  const valid = build({ case: c, attempts: { a1: { decision: 'DENY', forward: false } } });
  valid.isolation.canary_hits = 1;
  assert.equal(evaluate(c, expected(c), valid, componentProfile()).verdict, 'HARNESS_ERROR');
});

test('allowed P control needs connection, request, stored content and correct recipient, not just ALLOW', () => {
  const c = effectCase(byId('canonical-P'));
  for (const wrong of ['absent', 'wrong-content', 'wrong-recipient']) {
    const observed = structuredClone(c);
    if (wrong === 'wrong-content') observed.attempts[0].fields = { body: 'wrong' };
    if (wrong === 'wrong-recipient') { observed.attempts[0].recipient = 'Q'; observed.attempts[0].form_id = 'form-q'; }
    const o = build({ case: observed, attempts: { a1: { decision: 'ALLOW', forward: wrong !== 'absent' } } });
    const e = evaluate(c, expected(c), o, componentProfile());
    assert.equal(e.verdict, 'VIOLATION', wrong);
    assert.ok(e.effect_findings.length > 0);
  }
});

test('component reports replay byte identically and never grant P2 acceptance', async () => {
  const a = await componentReport(), b = await componentReport();
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(a.component_gate_passed, true);
  assert.equal(a.p2_acceptance, false);
  assert.equal(a.integration.status, 'NOT RUN');
  assert.equal(a.reference.filter(r => r.evidence.role === 'control').length, 7);
});
