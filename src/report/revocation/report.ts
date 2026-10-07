import { Evidence, VERSION } from '../../spec/revocation/model';
export const LIMITATIONS = [
  'Designed synthetic coverage, not statistical sampling or production failure probability.',
  'Reference runtime and behaviour faults are synthetic; no pinned ACS or production runtime integration.',
  'Decision evidence and effect evidence remain separate; cancellation receipt is not termination or rollback.',
  'Logical schedule ordering, not measured wall-clock revocation latency.',
  'Imported observations are adapter-declared; actual barrier closure and hidden effects are not independently verified.',
  'No UI, OS, network, filesystem, credential or process isolation verification.',
  'Human-authored corpus, oracle and faults may share conceptual blind spots.',
];
export function buildReport(evidence: Evidence[], corpus_sha256: string, observation_source: 'synthetic_harness_trace' | 'external_adapter_declared_unverified') {
  const counts = { PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, assessed: 0, total: evidence.length };
  for (const e of evidence) counts[e.verdict]++;
  counts.assessed = counts.PASS + counts.VIOLATION;
  return { version: VERSION, observation_source, corpus_sha256, counts, all_required_assessed: counts.assessed === counts.total && counts.total > 0 && evidence.every(e => e.incomplete.length === 0), acceptance_passed: counts.PASS === counts.total && counts.total > 0, limitations: LIMITATIONS, evidence };
}
export function summary(r: ReturnType<typeof buildReport>): string {
  return `# Runtime Revocation & Containment Evaluation\n\nVersion: ${r.version}\n\nObservation source: ${r.observation_source}\n\nCorpus SHA-256: ${r.corpus_sha256}\n\n` +
    `PASS: ${r.counts.PASS}; VIOLATION: ${r.counts.VIOLATION}; UNASSESSABLE: ${r.counts.UNASSESSABLE}; HARNESS_ERROR: ${r.counts.HARNESS_ERROR}. Assessed: ${r.counts.assessed}/${r.counts.total}.\n\nAcceptance passed: ${r.acceptance_passed}. All required assessed: ${r.all_required_assessed}.\n\n` +
    '| Case | Stage | Verdict | Decision findings | Effect findings | Incomplete |\n|---|---|---|---|---|---|\n' +
    r.evidence.map(e => `| ${e.case_id} | ${e.stage} | ${e.verdict} | ${e.decision_findings.map(f => `${f.reason}@${f.step}`).join(', ')} | ${e.effect_findings.map(f => `${f.reason}@${f.step}`).join(', ')} | ${e.incomplete.join(', ')} |`).join('\n') +
    '\n\n' + r.limitations.map(l => `- ${l}`).join('\n') + '\n';
}
