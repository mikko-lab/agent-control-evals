import { observe, Fault } from '../../adapter/revocation-reference/runtime';
import { Case, Expected } from '../../spec/revocation/model';
import { evaluate } from './evaluate';
export const WITNESSES: { fault: Fault; case_id: string; channel: 'decision_findings' | 'effect_findings'; reason: string }[] = [
  { fault: 'late_approval', case_id: 'pending-approval', channel: 'effect_findings', reason: 'unexpected_approval_granted' },
  { fault: 'stale_permit', case_id: 'issued-permit', channel: 'effect_findings', reason: 'unexpected_execution_started' },
  { fault: 'session_bypass', case_id: 'active-session', channel: 'effect_findings', reason: 'unexpected_execution_started' },
  { fault: 'commit_bypass', case_id: 'in-flight-before-commit', channel: 'effect_findings', reason: 'unexpected_tool_commit' },
  { fault: 'delivery_bypass', case_id: 'in-flight-after-commit', channel: 'effect_findings', reason: 'unexpected_output_delivery' },
  { fault: 'forgotten_descendants', case_id: 'derived-authority', channel: 'effect_findings', reason: 'unexpected_execution_started' },
  { fault: 'deny_with_effect', case_id: 'in-flight-before-commit', channel: 'effect_findings', reason: 'unexpected_tool_commit' },
  { fault: 'erased_history', case_id: 'in-flight-after-commit', channel: 'effect_findings', reason: 'missing_tool_commit' },
];
export function faultRuns(cases: Case[], truths: Expected[]) {
  return WITNESSES.map(w => {
    const observations = cases.map(c => observe(c, w.fault));
    const evidence = cases.map((c, i) => evaluate(c, truths[i], observations[i]));
    const valid = evidence.every(e => e.verdict !== 'HARNESS_ERROR' && e.incomplete.length === 0);
    const witness = evidence.find(e => e.case_id === w.case_id)!;
    const killed = valid && witness.verdict === 'VIOLATION' && witness[w.channel].some(f => f.reason === w.reason);
    return { ...w, valid, killed, observations, evidence };
  });
}
