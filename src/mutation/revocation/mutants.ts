/**
 * SUT mutants of the revocation track's pinned runtime (docs/revocation/runtime-adapter-compatibility.md, section 10).
 * Each is one type-safe patch of one file of acs-guardrail-demo@a682e44 under mutations/revocation/, applied to a fresh
 * checkout. Witnesses are fixed here before any mutant run. A mutant that does not apply or does not typecheck is a
 * technical failure of the gate, never a kill.
 */
import type { Evidence, Finding } from '../../spec/revocation/model';

export interface Witness {
  /** corpus: an IN_PROFILE corpus case; supplement: a supplement case. */
  set: 'corpus' | 'supplement';
  case_id: string;
  verdict: 'VIOLATION' | 'UNASSESSABLE';
  decision_findings: Finding[];
  effect_findings: Finding[];
  /** When given, the witness case's incompleteness must be exactly this set. */
  incomplete_exactly?: string[];
  /** When given, the run's exit code must be this one. */
  exit?: number;
}
export interface RevocationMutant { id: string; patch: string; target: string; description: string; witness: Witness }
const f = (reason: string, step: number): Finding => ({ reason, step });

export const MUTANTS: RevocationMutant[] = [
  { id: 'M1', patch: 'M1-terminal-ignores-registered-work.patch', target: 'src/managed-execution.ts', description: '#maybeTerminal ignores pending registered work: a premature terminal when the tool function settles.',
    witness: { set: 'corpus', case_id: 'commit-before-cut', verdict: 'VIOLATION', decision_findings: [], effect_findings: [f('unexpected_execution_terminal', 2)] } },
  { id: 'M2', patch: 'M2-commit-skips-revocation-check.patch', target: 'src/managed-execution.ts', description: 'The commit binding check skips deps.revoked().',
    witness: { set: 'corpus', case_id: 'start-before-cut', verdict: 'VIOLATION', decision_findings: [f('false_allow', 2)], effect_findings: [f('unexpected_tool_commit', 2)] } },
  { id: 'M3', patch: 'M3-commit-ignores-terminal.patch', target: 'src/managed-execution.ts', description: 'The commit entry and binding checks ignore the terminal state.',
    witness: { set: 'supplement', case_id: 'sup-commit-after-terminal-no-revocation', verdict: 'VIOLATION', decision_findings: [f('false_allow', 3)], effect_findings: [f('unexpected_tool_commit', 3)] } },
  { id: 'M4', patch: 'M4-delivery-skips-revocation.patch', target: 'src/guarded-executor.ts', description: '#handOver and the result-processing delivery check skip revocation.',
    witness: { set: 'corpus', case_id: 'session-delivery-fence-after-commit', verdict: 'VIOLATION', decision_findings: [f('false_allow', 3)], effect_findings: [f('unexpected_output_delivery', 3)] } },
  { id: 'M5', patch: 'M5-revoke-requests-no-cancellation.patch', target: 'src/guarded-executor.ts', description: 'revoke() does not request cancellation of covered executions.',
    witness: { set: 'corpus', case_id: 'in-flight-before-commit', verdict: 'VIOLATION', decision_findings: [f('false_deny', 2)], effect_findings: [f('missing_cancellation_ack', 2)] } },
  { id: 'M6', patch: 'M6-session-scope-checked-by-capability-only.patch', target: 'src/authority-revocation.ts', description: 'Session-scope revocation is checked against the capability only.',
    witness: { set: 'corpus', case_id: 'active-session', verdict: 'VIOLATION', decision_findings: [f('false_allow', 1), f('false_allow', 2)], effect_findings: [f('unexpected_execution_started', 1), f('unexpected_execution_started', 2)] } },
  { id: 'M7', patch: 'M7-capability-revocation-over-reach.patch', target: 'src/authority-revocation.ts', description: 'A capability revocation is applied to every capability the runtime instance checks (over-reach; in sibling-isolation all capabilities share the revoked child\'s runtime session).',
    witness: { set: 'corpus', case_id: 'sibling-isolation', verdict: 'VIOLATION', decision_findings: [f('false_deny', 2), f('false_deny', 7)], effect_findings: [f('missing_execution_started', 2), f('missing_execution_started', 7)] } },
  { id: 'M8', patch: 'M8-approval-and-start-stage-checks-removed.patch', target: 'src/guarded-executor.ts', description: 'The approval-stage and start-stage revocation checks are removed (the request-stage check stays).',
    witness: { set: 'supplement', case_id: 'sup-pending-approval-revoked', verdict: 'VIOLATION', decision_findings: [f('false_allow', 1)], effect_findings: [f('unexpected_execution_started', 1)] } },
  { id: 'M9', patch: 'M9-request-and-start-stage-checks-removed.patch', target: 'src/guarded-executor.ts', description: 'The request-stage and start-stage revocation checks are removed.',
    witness: { set: 'corpus', case_id: 'cut-before-start', verdict: 'VIOLATION', decision_findings: [f('false_allow', 1)], effect_findings: [f('unexpected_execution_started', 1)] } },
  { id: 'M10', patch: 'M10-terminal-never-recorded.patch', target: 'src/managed-execution.ts', description: '#maybeTerminal never records a terminal.',
    witness: { set: 'corpus', case_id: 'start-before-cut', verdict: 'UNASSESSABLE', decision_findings: [], effect_findings: [], exit: 2 } },
  { id: 'M11', patch: 'M11-premature-terminal-for-unobservable-settlement.patch', target: 'src/managed-execution.ts', description: 'Restores the pre-#10 premature failed terminal for an unobservable settlement.',
    witness: { set: 'supplement', case_id: 'sup-unobservable-pending-settlement', verdict: 'VIOLATION', decision_findings: [], effect_findings: [f('unexpected_execution_terminal', 0)], incomplete_exactly: ['terminal evidence missing for e1 in window 1..2'], exit: 1 } },
];

const has = (actual: Finding[], required: Finding[]) => required.every(r => actual.some(a => a.reason === r.reason && a.step === r.step));
/** Whether the witness holds for the witness case's evidence and the run's exit code. Returns the reasons it does not. */
export function witnessFailures(w: Witness, e: Evidence | undefined, exit: number): string[] {
  if (!e) return [`witness case ${w.case_id} was not evaluated`];
  const out: string[] = [];
  if (e.verdict !== w.verdict) out.push(`verdict ${e.verdict} != ${w.verdict}`);
  if (e.errors.length) out.push(`errors ${e.errors.map(x => x.code).join(',')}`);
  if (!has(e.decision_findings, w.decision_findings)) out.push(`decision findings ${JSON.stringify(e.decision_findings)} lack ${JSON.stringify(w.decision_findings)}`);
  if (!has(e.effect_findings, w.effect_findings)) out.push(`effect findings ${JSON.stringify(e.effect_findings)} lack ${JSON.stringify(w.effect_findings)}`);
  if (w.incomplete_exactly && JSON.stringify([...e.incomplete].sort()) !== JSON.stringify([...w.incomplete_exactly].sort())) out.push(`incomplete ${JSON.stringify(e.incomplete)} != ${JSON.stringify(w.incomplete_exactly)}`);
  if (w.exit !== undefined && exit !== w.exit) out.push(`exit ${exit} != ${w.exit}`);
  return out;
}
