import { canonicalJson } from '../../util/canonical-json';
import { Evidence, StateAtCut, VERSION } from '../../spec/revocation/model';
export const LIMITATIONS = [
  'Designed synthetic coverage, not statistical sampling or production failure probability.',
  'Reference runtime and behaviour faults are synthetic; no pinned ACS or production runtime integration.',
  'Decision evidence and effect evidence remain separate; cancellation receipt is not termination or rollback.',
  'Logical schedule ordering at the revoke step, not measured wall-clock revocation latency or a production runtime\'s actual effective time.',
  'Imported observations are adapter-declared; occurrence steps, terminal reports, actual barrier closure and hidden effects are not independently verified.',
  'No UI, OS, network, filesystem, credential or process isolation verification.',
  'Human-authored corpus, oracle and faults may share conceptual blind spots; faults may share witnesses and are not claimed to be mutually distinguishable.',
  'The manifest binds compiled harness modules, compiled schemas and lockfile bytes; it does not verify installed dependencies, the Node.js runtime or an external SUT identity, and it is not a signed attestation.',
];
export type ObservationSource = 'synthetic_harness_trace' | 'external_adapter_declared_unverified';
export function buildReport(evidence: Evidence[], corpus_sha256: string, observation_source: ObservationSource) {
  const counts = { PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, assessed: 0, total: evidence.length, confirmed_violation_cases: 0 };
  for (const e of evidence) { counts[e.verdict]++; if (e.confirmed_violation) counts.confirmed_violation_cases++; }
  counts.assessed = counts.PASS + counts.VIOLATION;
  const technically_valid = counts.total > 0 && counts.HARNESS_ERROR === 0 && evidence.every(e => e.incomplete.length === 0);
  return {
    version: VERSION, observation_source, corpus_sha256, counts, technically_valid,
    // Confirmed findings count even when they were retained inside HARNESS_ERROR or incomplete cases.
    has_confirmed_violation: counts.confirmed_violation_cases > 0,
    all_required_assessed: counts.assessed === counts.total && technically_valid,
    acceptance_passed: counts.PASS === counts.total && counts.total > 0,
    limitations: LIMITATIONS, evidence,
  };
}
export type Report = ReturnType<typeof buildReport>;
const cell = (s: string) => s.replace(/\|/g, '\\|');
export function renderCut(cut: StateAtCut): string {
  const target = cut.target.scope === 'authority' ? `authority:${cut.target.id}` : cut.target.scope === 'session' ? `session:${cut.target.tenant}/${cut.target.session}` : `tenant:${cut.target.tenant}`;
  const authorities = cut.authorities.map(a => `${a.id}=${a.grant}${a.revoked === 'no' ? '' : a.revoked === 'by_cut' ? ' revoked' : ' already-revoked'}${a.executions.length ? ` [${a.executions.map(x => `${x.id}:${x.phase}`).join(' ')}]` : ''}`);
  return `@${cut.step} ${target}: ${authorities.join('; ')}`;
}
export function summary(r: Report): string {
  return `# Runtime Revocation & Containment Evaluation\n\nVersion: ${r.version}\n\nObservation source: ${r.observation_source}\n\nCorpus SHA-256: ${r.corpus_sha256}\n\n` +
    `PASS: ${r.counts.PASS}; VIOLATION: ${r.counts.VIOLATION}; UNASSESSABLE: ${r.counts.UNASSESSABLE}; HARNESS_ERROR: ${r.counts.HARNESS_ERROR}. Assessed: ${r.counts.assessed}/${r.counts.total}.\n\n` +
    `Technically valid: ${r.technically_valid}. Has confirmed violation: ${r.has_confirmed_violation} (${r.counts.confirmed_violation_cases} case(s), including findings retained in HARNESS_ERROR or incomplete cases). Acceptance passed: ${r.acceptance_passed}. All required assessed: ${r.all_required_assessed}.\n\n` +
    'Family is the scenario design intent; state at cut is replayed from the corpus by the oracle.\n\n' +
    '| Case | Family | State at cut | Verdict | Decision findings | Effect findings | Incomplete | Errors |\n|---|---|---|---|---|---|---|---|\n' +
    r.evidence.map(e => `| ${e.case_id} | ${e.family} | ${cell(e.state_at_cut.map(renderCut).join('<br>'))} | ${e.verdict} | ${e.decision_findings.map(f => `${f.reason}@${f.step}`).join(', ')} | ${e.effect_findings.map(f => `${f.reason}@${f.step}`).join(', ')} | ${cell(e.incomplete.join(', '))} | ${cell(e.errors.map(x => `${x.code} ${x.path}`).join(', '))} |`).join('\n') +
    '\n\n' + r.limitations.map(l => `- ${l}`).join('\n') + '\n';
}
/** Stable bytes for a report file. */
export const reportJson = (r: Report) => canonicalJson(r) + '\n';
