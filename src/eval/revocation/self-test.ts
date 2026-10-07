import { observe, Fault } from '../../adapter/revocation-reference/runtime';
import { Case, Evidence, Expected, Finding } from '../../spec/revocation/model';
import { evaluate } from './evaluate';
type Channel = Finding[] | 'clean';
/**
 * Fixed witnesses, declared before any run. A witness names its case, the decision and effect findings that must be
 * present (with their steps), and 'clean' where the other channel must have no finding at all. A fault is killed only
 * when every case of its run is technically valid with sufficient evidence (no HARNESS_ERROR, nothing incomplete).
 */
export interface Witness { fault: Fault; case_id: string; claim: string; decision_findings: Channel; effect_findings: Channel }
const f = (reason: string, step: number): Finding => ({ reason, step });
export const WITNESSES: Witness[] = [
  { fault: 'late_approval', case_id: 'pending-approval', claim: 'approval granted after the cut', decision_findings: [f('false_allow', 1)], effect_findings: [f('unexpected_approval_granted', 1)] },
  { fault: 'issue_bypass', case_id: 'issue-after-cut', claim: 'permit issued after the cut for an approved authority', decision_findings: [f('false_allow', 2)], effect_findings: [f('unexpected_permit_issued', 2)] },
  { fault: 'stale_permit', case_id: 'issued-permit', claim: 'unused permit starts after the cut', decision_findings: [f('false_allow', 1)], effect_findings: [f('unexpected_execution_started', 1)] },
  { fault: 'session_start_bypass', case_id: 'active-session', claim: 'session-scope cut does not fence start', decision_findings: [f('false_allow', 1), f('false_allow', 2)], effect_findings: [f('unexpected_execution_started', 1), f('unexpected_execution_started', 2)] },
  { fault: 'session_in_flight_bypass', case_id: 'session-in-flight-commit-fence', claim: 'session-scope cut does not fence a running execution\'s commit', decision_findings: [f('false_allow', 3)], effect_findings: [f('unexpected_tool_commit', 3)] },
  { fault: 'tenant_single_session', case_id: 'tenant-multi-session-in-flight', claim: 'tenant cut reaches only one session of the tenant', decision_findings: [f('false_allow', 5)], effect_findings: [f('unexpected_tool_commit', 5)] },
  { fault: 'commit_bypass', case_id: 'in-flight-before-commit', claim: 'policy allows and performs a commit after the cut', decision_findings: [f('false_allow', 3)], effect_findings: [f('unexpected_tool_commit', 3)] },
  { fault: 'deny_with_effect', case_id: 'in-flight-before-commit', claim: 'correct DENY but the commit still happens', decision_findings: 'clean', effect_findings: [f('unexpected_tool_commit', 3)] },
  { fault: 'delivery_bypass', case_id: 'in-flight-after-commit', claim: 'delivery after the cut of an already committed execution', decision_findings: [f('false_allow', 4)], effect_findings: [f('unexpected_output_delivery', 4)] },
  { fault: 'forgotten_descendants', case_id: 'derived-in-flight-ancestor-revoked', claim: 'ancestor cut does not reach a running derived execution', decision_findings: [f('false_allow', 2)], effect_findings: [f('unexpected_tool_commit', 2)] },
  { fault: 'erased_history', case_id: 'in-flight-after-commit', claim: 'revocation erases the historical commit', decision_findings: 'clean', effect_findings: [f('missing_tool_commit', 1)] },
  { fault: 'decision_only_false_allow', case_id: 'in-flight-before-commit', claim: 'decision record says ALLOW while the commit is contained', decision_findings: [f('false_allow', 3)], effect_findings: 'clean' },
  { fault: 'decision_only_false_deny', case_id: 'sibling-isolation', claim: 'decision record says DENY for an unaffected sibling whose commit correctly happens', decision_findings: [f('false_deny', 3)], effect_findings: 'clean' },
  { fault: 'write_behind_commit', case_id: 'commit-shift-across-cut', claim: 'commit expected before the cut materializes after it', decision_findings: 'clean', effect_findings: [f('missing_tool_commit', 1), f('unexpected_tool_commit', 3)] },
  { fault: 'execution_id_reuse', case_id: 'execution-id-reuse', claim: 'another authority reuses a running execution ID', decision_findings: [f('false_allow', 1)], effect_findings: [f('unexpected_execution_started', 1)] },
];
const holds = (actual: Finding[], required: Channel) => required === 'clean' ? actual.length === 0 : required.every(r => actual.some(a => a.reason === r.reason && a.step === r.step));
export function witnessHolds(w: Witness, e: Evidence): boolean {
  return e.case_id === w.case_id && e.verdict === 'VIOLATION' && holds(e.decision_findings, w.decision_findings) && holds(e.effect_findings, w.effect_findings);
}
export const runValid = (evidence: Evidence[]) => evidence.every(e => e.verdict !== 'HARNESS_ERROR' && e.incomplete.length === 0);
export function faultRuns(cases: Case[], truths: Expected[]) {
  return WITNESSES.map(w => {
    const observations = cases.map(c => observe(c, w.fault));
    const evidence = cases.map((c, i) => evaluate(c, truths[i], observations[i]));
    const valid = runValid(evidence);
    const killed = valid && witnessHolds(w, evidence.find(e => e.case_id === w.case_id)!);
    // Shared observations are expected; report which other declared witnesses this fault also satisfies.
    const also_satisfies = WITNESSES.filter(v => v.fault !== w.fault && witnessHolds(v, evidence.find(e => e.case_id === v.case_id)!)).map(v => v.fault);
    return { ...w, valid, killed, also_satisfies, observations, evidence };
  });
}
