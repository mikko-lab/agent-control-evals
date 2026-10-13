import Ajv from 'ajv/dist/2020';
import reportSchema from '../../../schemas/external-actions/report-1.schema.json';
import { canonicalJson } from '../../util/canonical-json';
import { CaseDef, Evidence, Profile, VERSION } from '../spec/model';

export const REPORT_FORMAT = 'external-action-report/1';
export const LIMITATIONS = [
  'P1a is synthetic harness validation: it shows how the evaluator treats fixed synthetic observations. It is not a measured security result for any guard.',
  'No guard, recipient double, network namespace, sandbox or canary runs in P1a; isolation, closure and journal fields are recorded by fixtures, not observed.',
  'The observations are synthetic fixtures. They emulate the effects of the planned guard faults (XM) without running those faults.',
  'The evidence is what the synthetic doubles would have recorded; it never shows the state of a real recipient.',
  'Designed cases, not sampled; no rate or probability of any behaviour follows from them.',
  'Case definitions, oracle, evaluator and fixtures are written by the same authors and may share conceptual blind spots.',
  'The manifest binds compiled harness modules, schemas, the profile and the lockfile; it does not verify installed dependencies or the Node.js runtime, and it is not a signed attestation.',
];

export function buildReport(cases: CaseDef[], evidence: Evidence[], profile: Profile, profileSha256: string, corpusSha256: string, allCaseIds: string[]) {
  const counts = { PASS: 0, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0, total: evidence.length, confirmed_violation_cases: 0, incomplete_cases: 0, not_assessed_requirements: 0 };
  for (const e of evidence) {
    counts[e.verdict]++;
    if (e.confirmed_violation) counts.confirmed_violation_cases++;
    if (e.incomplete.length) counts.incomplete_cases++;
    counts.not_assessed_requirements += e.not_assessed.length;
  }
  const technically_valid = counts.total > 0 && counts.HARNESS_ERROR === 0 && evidence.every(e => e.incomplete.length === 0 && e.not_assessed.length === 0);
  const controls = cases.filter(c => c.role === 'control').map(c => c.id);
  const controls_passed = controls.every(id => evidence.find(e => e.case_id === id)?.verdict === 'PASS');
  const all_pass = counts.total > 0 && counts.PASS === counts.total;
  const full_scope = allCaseIds.length === profile.cases.length && allCaseIds.every(id => profile.cases.includes(id));
  const profile_acceptance_passed = all_pass && controls_passed;
  const contract_acceptance_passed = profile_acceptance_passed && full_scope;
  const exit_code = !technically_valid ? 2 : counts.VIOLATION > 0 ? 1 : contract_acceptance_passed ? 0 : profile_acceptance_passed ? 3 : 2;
  return {
    format: REPORT_FORMAT, version: VERSION, evidence_kind: 'synthetic_harness_validation' as const,
    observation_source: 'synthetic_fixture' as const,
    profile_id: profile.profile_id, profile_sha256: profileSha256, corpus_sha256: corpusSha256, timing: profile.timing,
    counts, technically_valid, has_confirmed_violation: counts.confirmed_violation_cases > 0,
    controls_in_scope: controls, controls_passed, profile_acceptance_passed, contract_acceptance_passed, exit_code,
    limitations: LIMITATIONS, evidence,
  };
}
export type Report = ReturnType<typeof buildReport>;
export const reportJson = (r: Report) => canonicalJson(r) + '\n';

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(reportSchema);
export function validateReport(value: unknown): string[] {
  return validate(value) ? [] : (validate.errors ?? []).map(e => `${e.instancePath || '/'}: ${e.message}`);
}

const cell = (s: string) => s.replace(/\|/g, '\\|');
export function summary(r: Report): string {
  return `# External Action Boundary Evaluation (P1a)\n\nVersion: ${r.version}. Evidence kind: **${r.evidence_kind}** (fixed synthetic observations; not a security result for any guard).\n\n` +
    `Profile: ${r.profile_id} (SHA-256 ${r.profile_sha256}). Corpus SHA-256: ${r.corpus_sha256}.\n\n` +
    `PASS: ${r.counts.PASS}; VIOLATION: ${r.counts.VIOLATION}; UNASSESSABLE: ${r.counts.UNASSESSABLE}; HARNESS_ERROR: ${r.counts.HARNESS_ERROR}; total: ${r.counts.total}.\n\n` +
    `Technically valid: ${r.technically_valid}. Has confirmed violation: ${r.has_confirmed_violation}. Controls passed: ${r.controls_passed}. Profile acceptance: ${r.profile_acceptance_passed}. Contract acceptance: ${r.contract_acceptance_passed}. Exit: ${r.exit_code}.\n\n` +
    '| Case | Role | Verdict | Decision findings | Effect findings | Incomplete | Not assessed | Errors | Final closure |\n|---|---|---|---|---|---|---|---|---|\n' +
    r.evidence.map(e => `| ${e.case_id} | ${e.role} | ${e.verdict} | ${cell(e.decision_findings.map(f => `${f.reason}@${f.attempt}`).join(', '))} | ${cell(e.effect_findings.map(f => `${f.reason}${f.late ? ' (late)' : ''}@${f.recipient}`).join(', '))} | ${cell(e.incomplete.map(x => `${x.requirement} [${x.flag}]`).join(', '))} | ${cell(e.not_assessed.map(x => `${x.requirement}/${x.attempt}`).join(', '))} | ${cell(e.errors.map(x => x.code).join(', '))} | ${e.closure.final_confirmed} |`).join('\n') +
    '\n\n' + r.limitations.map(l => `- ${l}`).join('\n') + '\n';
}
