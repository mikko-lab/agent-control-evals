import test from 'node:test';
import assert from 'node:assert/strict';
import { componentReport, referenceComponentsPass } from '../../src/external-actions/p2/components';
import { routeCases } from '../../src/external-actions/p2/corpus';
import { evaluateLive, liveMutationDetected, semanticLive } from '../../src/external-actions/p2/live-evaluate';
import { digest, Event, eventHash, ips, LiveRun, roles, Role } from '../../src/external-actions/p2/live-model';
import { configurationIssues, filter } from '../../src/external-actions/p2/topology';
import { validateP2Report } from '../../src/external-actions/p2/report-schema';

import { fixture, rechain } from './p2-test-fixtures';

test('component gate rejects exact transport corruption despite unchanged fixture PASS', async () => {
  const report = await componentReport();
  for (const change of [
    (r: any) => { r.transport_calls[0].endpoint.address = ips.q; },
    (r: any) => { r.transport_calls[0].endpoint.port = 80; },
    (r: any) => { r.transport_calls[0].endpoint.path = '/wrong'; },
    (r: any) => { r.transport_calls[0].body = 'wrong'; },
    (r: any) => { r.transport_calls = []; },
    (r: any) => { r.transport_calls.push(structuredClone(r.transport_calls[0])); },
    (r: any) => { r.guard_decision = 'DENY'; },
  ]) { const records = structuredClone(report.reference); change(records[0]); assert.equal(records[0].evidence.verdict, 'PASS'); assert.equal(referenceComponentsPass(records), false); }
  const forbidden = structuredClone(report.reference); forbidden[1].transport_calls = structuredClone(forbidden[0].transport_calls); assert.equal(referenceComponentsPass(forbidden), false);
  validateP2Report(report);
});

test('offline schema path validates and replays synthetic contract inputs deterministically', () => {
  const r = fixture(); const a = evaluateLive(r), b = evaluateLive(JSON.parse(JSON.stringify(r)));
  assert.equal(a.run_passed, true); assert.equal(semanticLive(a), semanticLive(b)); validateP2Report(a);
  assert.throws(() => validateP2Report({ ...a, evidence_kind: 'synthetic_component_validation' }));
  assert.throws(() => validateP2Report({ ...a, format: 'external-action-p2-live-report/99' }));
  assert.throws(() => evaluateLive({ ...r, format: 'unknown' }));
  assert.throws(() => evaluateLive({ ...r, cases: r.cases.slice(1) }));
  const duplicate = fixture(); duplicate.cases[1] = duplicate.cases[0]; assert.throws(() => evaluateLive(duplicate));
});

test('foreign run, case, attempt, missing journal and corrupt chain never pass', () => {
  for (const mutate of [
    (r: LiveRun) => { r.cases[0].run = 'foreign'; },
    (r: LiveRun) => { r.cases[0].events.p[0].run = 'foreign'; rechain(r.cases[0].events.p); },
    (r: LiveRun) => { r.cases[0].events.p[0].case = r.cases[1].case; rechain(r.cases[0].events.p); },
    (r: LiveRun) => { (r.cases[0].events.p[0] as any).attempt = 'other'; },
    (r: LiveRun) => { r.cases[0].events.p = []; },
    (r: LiveRun) => { r.cases[0].events.p[0].hash = '0'.repeat(64); },
  ]) { const r = fixture(); mutate(r); try { assert.equal(evaluateLive(r).run_passed, false); } catch (e) { assert.match(String(e), /schema/); } }
});

test('unchanged but unsafe configuration is rejected, as are changed filters and writable channels', () => {
  const r = fixture(); const config = JSON.parse(r.cases[0].isolation.before); config.x.filter = config.x.filter.replace(':OUTPUT DROP', ':OUTPUT ACCEPT');
  assert.ok(configurationIssues(JSON.stringify(config)).includes('filter:x'));
  r.cases[0].isolation.before = r.cases[0].isolation.after = JSON.stringify(config);
  r.cases[0].isolation.before_hash = r.cases[0].isolation.after_hash = digest(JSON.stringify(config));
  assert.equal(evaluateLive(r).cases[0].verdict, 'HARNESS_ERROR');
  const channel = fixture(); channel.cases[0].isolation.channels_after = false; assert.equal(evaluateLive(channel).cases[0].verdict, 'HARNESS_ERROR');
});

test('proxy receipt cannot substitute for final delivery, and wrong-hop peer fails attribution', () => {
  const r = fixture(), c = r.cases.find(c => c.case === 'proxy-P')!;
  c.events.p = c.events.p.filter(e => e.kind === 'closed'); c.states.p.records = []; c.events.p[0].data.records = []; rechain(c.events.p);
  assert.equal(evaluateLive(r).cases.find(c => c.case_id === 'proxy-P')!.verdict, 'VIOLATION');
  const wrong = fixture(), p = wrong.cases.find(c => c.case === 'proxy-P')!;
  p.events.p[0].data.peer = ips.e; rechain(p.events.p);
  assert.ok(evaluateLive(wrong).cases.find(c => c.case_id === 'proxy-P')!.errors.includes('attribution:p'));
});

test('closed state and final journal must agree; timeouts never pass or kill a mutant', () => {
  const r = fixture(); r.cases[0].states.p.records = ['invented']; assert.equal(evaluateLive(r).cases[0].verdict, 'HARNESS_ERROR');
  const timeout = fixture(); timeout.cases[0].processes[0].timed_out = true; assert.equal(evaluateLive(timeout).cases[0].verdict, 'UNASSESSABLE');
  const fault = evaluateLive(timeout); fault.guard = 'deny-all'; assert.equal(liveMutationDetected(fault), false);
});
