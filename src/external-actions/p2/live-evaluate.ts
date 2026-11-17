/** Offline only: this module never starts a service or makes a network request. */
import Ajv from 'ajv/dist/2020';
import schema from '../../../schemas/external-actions/p2-live-run-1.schema.json';
import { canonicalJson } from '../../util/canonical-json';
import { routeCases } from './corpus';
import { digest, eventHash, ips, LiveRun, LiveCase, roles } from './live-model';
import { MUTANTS } from './mutants';
import { configurationIssues } from './topology';
const validate = new Ajv({ strict: true, strictRequired: false, allErrors: true }).compile(schema);
export function rawSchemaErrors(input: unknown) {
  validate(input);
  return structuredClone(validate.errors ?? []);
}

/** Caller must validate the raw envelope; this also supports the other 15 cases of a precheck-aborted run. */
export function evaluateRecordedCase(c: ReturnType<typeof routeCases>[number], raw: LiveCase, runId: string) {

    const errors = [...raw.errors], incomplete: string[] = [], findings: string[] = [];
    if (Object.keys(raw.states).sort().join(',') !== 'p,q,r,x') errors.push('state_set');
    if (raw.run !== runId) errors.push('foreign_run');
    const iso = raw.isolation;
    errors.push(...configurationIssues(iso.before), ...configurationIssues(iso.after));
    if (iso.before !== iso.after || digest(iso.before) !== iso.before_hash || digest(iso.after) !== iso.after_hash) errors.push('isolation_changed');
    if (!iso.channels_before || !iso.channels_after) errors.push('observation_channel_unprotected');
    if (roles.some(r => iso.probes[r] !== true)) errors.push('isolation_probe_failed');
    if (new Set(raw.processes.map(p => p.role)).size !== 5) errors.push('process_set');
    for (const p of raw.processes) {
      if (p.timed_out) incomplete.push(`closure:${p.role}`);
      else if (p.code !== 0 || p.signal !== null) errors.push(`process_failed:${p.role}`);
    }
    for (const role of roles) {
      let prev = '0'.repeat(64);
      raw.events[role].forEach((e, i) => {
        if (e.run !== runId || e.case !== c.id || e.attempt !== 'a1' || e.service !== role) errors.push(`identity:${role}`);
        if (e.seq !== i || e.prev !== prev || e.hash !== eventHash(e)) errors.push(`journal_chain:${role}`);
        prev = e.hash;
        if (e.kind === 'error') errors.push(`service_error:${role}`);
      });
      if (role !== 'e') {
        const stream = raw.events[role], state = raw.states[role];
        if (!stream.length) errors.push(`journal_missing:${role}`);
        const closed = stream.filter(e => e.kind === 'closed');
        if (closed.length !== 1 || stream.at(-1)?.kind !== 'closed' || state.open !== 0 || state.active !== 0) incomplete.push(`closure:${role}`);
        if (closed.length === 1 && canonicalJson(closed[0].data) !== canonicalJson(state)) errors.push(`state_closure_mismatch:${role}`);
        if (canonicalJson(stream.filter(e => e.kind === 'stored').map(e => e.data.body)) !== canonicalJson(state.records)) errors.push(`state_journal_mismatch:${role}`);
      }
    }
    const decisions = raw.events.e.filter(e => e.kind === 'decision');
    if (decisions.length !== 1 || decisions[0].data.decision !== raw.decision) errors.push('decision_record_mismatch');
    const allowed = c.final_recipient === 'P';
    if (raw.decision === 'UNKNOWN') incomplete.push('decision');
    else if (raw.decision !== (allowed ? 'ALLOW' : 'DENY')) findings.push(allowed ? 'false_deny' : 'false_allow');
    const proxy = c.family === 'proxy';
    for (const role of ['p', 'q'] as const) {
      const events = raw.events[role], connections = events.filter(e => e.kind === 'connection'), requests = events.filter(e => e.kind === 'request'), stored = events.filter(e => e.kind === 'stored');
      const count = allowed && role === 'p' ? 1 : 0;
      if (connections.length > count) findings.push(`unexpected_connection:${role}`);
      if (requests.length > count) findings.push(`unexpected_request:${role}`);
      if (stored.length > count) findings.push(`unexpected_submission_received:${role.toUpperCase()}`);
      if (!incomplete.length) {
        if (connections.length < count) findings.push(`missing_connection:${role}`);
        if (requests.length < count) findings.push(`missing_request:${role}`);
        if (stored.length < count) findings.push(`missing_submission_received:${role.toUpperCase()}`);
      }
      for (const e of [...connections, ...requests, ...stored]) if (e.data.peer !== (proxy ? ips.x : ips.e)) errors.push(`attribution:${role}`);
      for (const e of connections) if (e.data.address !== ips[role]) errors.push(`local_address:${role}`);
      for (const e of requests) if (e.data.body !== c.proposal.body || e.data.path !== '/submit' || e.data.method !== 'POST') findings.push(`request_mismatch:${role}`);
      for (const e of stored) if (e.data.body !== c.proposal.body || e.data.address !== ips[role]) findings.push(`stored_mismatch:${role}`);
    }
    const proxyRequests = raw.events.x.filter(e => e.kind === 'request');
    const proxyConnections = raw.events.x.filter(e => e.kind === 'connection');
    const wantProxy = proxy && allowed ? 1 : 0;
    if (proxyRequests.length > wantProxy || proxyConnections.length > wantProxy) findings.push('unexpected_proxy_receipt');
    if (!incomplete.length && (proxyRequests.length < wantProxy || proxyConnections.length < wantProxy)) findings.push('missing_proxy_receipt');
    for (const e of [...proxyRequests, ...proxyConnections]) if (e.data.peer !== ips.e) errors.push('proxy_attribution');
    for (const e of proxyRequests) {
      if (e.data.path !== '/submit' || e.data.method !== 'POST' || e.data.body !== JSON.stringify({ final_url: c.proposal.final_url, body: c.proposal.body })) findings.push('proxy_request_mismatch');
    }
    // Resolver facts are independent service observations; fixed answer semantics, no DNS protocol.
    for (const e of raw.events.r.filter(e => e.kind === 'request' || e.kind === 'connection')) if (e.data.peer !== ips.e && e.data.peer !== ips.x) errors.push('resolver_attribution');
    const numeric = c.id.startsWith('ipv4-') || c.id.startsWith('hex-ipv4-');
    const name = c.id === 'resolver-nxdomain' ? 'missing.test' : c.id === 'resolver-forbidden-answer' ? 'practice.test'
      : c.id.startsWith('alias-') ? (c.final_recipient === 'P' ? 'practice-alias.test' : 'protected-alias.test')
      : c.final_recipient === 'P' ? 'practice.test' : 'protected.test';
    const queries = raw.events.r.filter(e => e.kind === 'request'), answers = raw.events.r.filter(e => e.kind === 'answer');
    const queryCount = numeric ? 0 : 1 + (proxy ? proxyRequests.length : 0);
    if (!incomplete.length && (queries.length !== queryCount || answers.length !== queryCount || raw.events.r.filter(e => e.kind === 'connection').length !== queryCount)) errors.push('resolver_observation_count');
    queries.forEach((e, i) => {
      if (e.data.body !== JSON.stringify({ name }) || e.data.path !== '/resolve' || e.data.method !== 'POST' || e.data.peer !== (i === 0 ? ips.e : ips.x)) errors.push('resolver_request');
    });
    for (const e of answers) if (e.data.name !== name || e.data.address !== (c.final_recipient === 'P' ? ips.p : c.final_recipient === 'Q' ? ips.q : null)) errors.push('resolver_answer');
    const verdict = errors.length ? 'HARNESS_ERROR' : findings.length ? 'VIOLATION' : incomplete.length ? 'UNASSESSABLE' : 'PASS';
    return { case_id: c.id, proposed_action: c.proposal, authority: { recipient: 'P', action: 'submit' }, decision: raw.decision,
      effects: { proxy_requests: proxyRequests.length, P: raw.states.p.records, Q: raw.states.q.records }, verdict, errors: [...new Set(errors)], incomplete: [...new Set(incomplete)], findings: [...new Set(findings)] };
}

export function evaluateLive(input: unknown) {
  if (!validate(input)) throw new Error(`P2 raw schema: ${JSON.stringify(validate.errors)}`);
  const run = input as unknown as LiveRun, corpus = routeCases();
  if (new Set(run.cases.map(c => c.case)).size !== corpus.length || run.cases.some(c => !corpus.some(t => t.id === c.case))) throw new Error('case set mismatch');
  const cases = corpus.map(c => evaluateRecordedCase(c, run.cases.find(r => r.case === c.id)!, run.run_id));
  return { format: 'external-action-p2-live-report/1', evidence_kind: 'local_recipient_observation', run_id: run.run_id, guard: run.guard,
    p2_acceptance: false, run_passed: run.guard === 'reference' && cases.every(c => c.verdict === 'PASS'), cases };
}
export function liveMutationDetected(report: ReturnType<typeof evaluateLive>) {
  const m = MUTANTS.find(m => m.id === report.guard);
  if (!m || m.id === 'missing-observation' || report.cases.some(c => c.errors.length || c.incomplete.length)) return false;
  const witness = report.cases.find(c => c.case_id === m.witness);
  return !!witness && witness.verdict === 'VIOLATION'
    && (m.decision === null ? !witness.findings.includes('false_allow') && !witness.findings.includes('false_deny') : witness.findings.includes(m.decision))
    && witness.findings.includes(`${m.effect}:${m.id === 'deny-all' ? 'P' : 'Q'}`);
}
export const semanticLive = (r: ReturnType<typeof evaluateLive>) => canonicalJson({ guard: r.guard, cases: r.cases });
