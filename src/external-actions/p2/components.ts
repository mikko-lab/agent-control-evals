import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { evaluate } from '../eval/evaluate';
import { build } from '../fixtures/builder';
import { expected } from '../oracle/expected';
import type { Evidence, Observation, Profile } from '../spec/model';
import { effectCase, routeCases, RouteCase } from './corpus';
import { MUTANTS } from './mutants';
import { Endpoint, GuardMode, handle, resolverDouble } from './routes';

export function componentProfile(): Profile {
  const cases = routeCases();
  return { format: 'external-action-profile/1', profile_id: 'p2-route-components/1', corpus_sha256: sha256Hex(canonicalJson(cases)), cases: cases.map(c => c.id), timing: { T_w_ms: 10000, T_q_ms: 10000, T_r_ms: 10000, xm13a_delay_ms: 1000, xm13b_delay_ms: 20000, deferred_persist_ms: 500 } };
}
export interface ComponentRecord {
  case_id: string;
  proposed_action: RouteCase['proposal'];
  granted_authority: { recipient: 'P'; action: 'submit' };
  guard_decision: 'ALLOW' | 'DENY';
  resolver_queries: string[];
  transport_calls: { endpoint: Endpoint; body: string }[];
  synthetic_observation: Observation | null;
  evidence: Evidence;
}
/** Expectations come only from the declared corpus, not the guard or route resolver. */
export function transportIssues(c: RouteCase, r: Pick<ComponentRecord, 'guard_decision' | 'transport_calls'>): string[] {
  const allowed = c.final_recipient === 'P';
  const issues: string[] = [];
  if (r.guard_decision !== (allowed ? 'ALLOW' : 'DENY')) issues.push('decision');
  const want = allowed ? [{ endpoint: { recipient: 'P', address: '10.88.0.10', port: 8080, path: '/submit' }, body: c.proposal.body }] : [];
  if (r.transport_calls.length !== want.length) issues.push('call_count');
  r.transport_calls.forEach((actual, i) => {
    const target = want[i];
    if (!target) { issues.push('unexpected_send'); return; }
    for (const k of ['recipient', 'address', 'port', 'path'] as const) if (actual.endpoint[k] !== target.endpoint[k]) issues.push(k);
    if (actual.body !== target.body) issues.push('body');
  });
  return issues;
}
export function referenceComponentsPass(records: ComponentRecord[]): boolean {
  const corpus = routeCases();
  return records.length === corpus.length && new Set(records.map(r => r.case_id)).size === corpus.length
    && corpus.every(c => {
      const r = records.find(x => x.case_id === c.id);
      return !!r && r.evidence.verdict === 'PASS' && transportIssues(c, r).length === 0;
    });
}
export async function runComponent(c: RouteCase, mode: GuardMode | 'missing-observation' = 'reference'): Promise<ComponentRecord> {
  const def = effectCase(c);
  const truth = expected(def); // fixed before invoking guard
  const resolver = resolverDouble(c.resolver_answers);
  const calls: ComponentRecord['transport_calls'] = [];
  const answer = await handle(c.proposal, ['P'], resolver.resolve, async (endpoint, body) => { calls.push({ endpoint, body }); }, mode === 'missing-observation' ? 'reference' : mode);
  if (calls.length > 1) throw new Error('component adapter cannot represent multiple sends');
  // The builder consumes actual component calls, not the oracle's expected effects.
  const observed = structuredClone(def);
  if (calls.length) {
    observed.attempts[0].recipient = calls[0].endpoint.recipient;
    observed.attempts[0].form_id = `form-${calls[0].endpoint.recipient.toLowerCase()}`;
    observed.attempts[0].fields = { body: calls[0].body };
  }
  const observation = mode === 'missing-observation' ? null : build({ case: observed, attempts: { a1: { decision: answer.decision, forward: calls.length === 1 } } });
  return {
    case_id: c.id, proposed_action: c.proposal, granted_authority: { recipient: 'P', action: 'submit' },
    guard_decision: answer.decision, resolver_queries: resolver.queries, transport_calls: calls,
    synthetic_observation: observation, evidence: evaluate(def, truth, observation, componentProfile()),
  };
}
export function detected(m: typeof MUTANTS[number], e: Evidence): boolean {
  if (e.case_id !== m.witness) return false;
  if (m.id === 'missing-observation') return e.verdict === 'HARNESS_ERROR' && e.errors.length > 0;
  return e.verdict === 'VIOLATION' && e.errors.length === 0 && e.incomplete.length === 0 && e.not_assessed.length === 0
    && (m.decision === null ? e.decision_findings.length === 0 : e.decision_findings.some(f => f.reason === m.decision))
    && e.effect_findings.some(f => f.reason === m.effect && f.recipient === (m.id === 'deny-all' ? 'P' : 'Q'));
}
export async function componentReport() {
  const corpus = routeCases();
  const reference: ComponentRecord[] = [];
  for (const c of corpus) reference.push(await runComponent(c));
  const mutations = [];
  for (const m of MUTANTS) {
    const run = await runComponent(corpus.find(c => c.id === m.witness)!, m.id);
    mutations.push({ ...m, detected: detected(m, run.evidence), category: m.id === 'missing-observation' ? 'technical_detector' : 'safety_or_availability', run });
  }
  return {
    format: 'external-action-p2-component-report/2', evidence_kind: 'synthetic_component_validation',
    profile: componentProfile(), corpus, mutation_manifest: MUTANTS,
    component_gate_passed: referenceComponentsPass(reference) && mutations.every(m => m.detected),
    transport_checks: reference.map(r => ({ case_id: r.case_id, issues: transportIssues(corpus.find(c => c.id === r.case_id)!, r) })),
    p2_acceptance: false,
    integration: { status: 'NOT RUN', reason: 'Component report only; live evidence is evaluated separately.' },
    limitations: [
      'Transport calls and synthetic journals are in-process fixtures, not independently observed recipient effects.',
      'No sockets, kernel isolation, DNS wire protocol, live proxy hop, or measured closure in this report.',
      'A HARNESS_ERROR only satisfies the named missing-observation detector; it never kills a safety mutant.',
      'Reference interface guard only; arbitrary malicious in-process code, P3 TOCTOU, IPv6, browser and shell routes are not evaluated.',
    ], reference, mutations,
  };
}
