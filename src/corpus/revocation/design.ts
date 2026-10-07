/**
 * Design claims for the revocation corpus. These are harness-side documentation checked against the oracle
 * replay by tests; they are never passed to a runtime. `required_denials` lists the exact set of reasons that
 * must explain a DENY, so a claim of ['revoked'] means revocation alone explains it (no overdetermination).
 */
export interface CaseDesign {
  purpose: string;
  required_denials: { step: number; reasons: string[] }[];
  allowed_after_cut: number[];
  retained_before_cut: number[];
}
const revoked = (...steps: number[]) => steps.map(step => ({ step, reasons: ['revoked'] }));
export const DESIGN: Record<string, CaseDesign> = {
  'pending-approval': { purpose: 'Late approval of a pending authority after its cut; later issue/start are overdetermined by the missing approval.', required_denials: revoked(1), allowed_after_cut: [], retained_before_cut: [] },
  'issue-after-cut': { purpose: 'Approval before the cut, permit issue attempted after it: only revocation explains the issue denial.', required_denials: revoked(2), allowed_after_cut: [], retained_before_cut: [0] },
  'issued-permit': { purpose: 'Unused issued permit after the cut, including a fresh-ID retry while the permit is still unconsumed.', required_denials: revoked(1, 2), allowed_after_cut: [], retained_before_cut: [] },
  'fresh-id-retry-unused-permit': { purpose: 'An earlier start failed before issue; after approve/issue and the cut a fresh-ID start finds an unused permit, so single use cannot explain its denial.', required_denials: [{ step: 0, reasons: ['permit_not_issued'] }, ...revoked(4)], allowed_after_cut: [], retained_before_cut: [1, 2] },
  'cut-before-start': { purpose: 'Race ordering pair with start-before-cut: the cut linearizes before the start.', required_denials: revoked(1), allowed_after_cut: [], retained_before_cut: [] },
  'duplicate-revocation': { purpose: 'Repeated revocation is idempotent and still fences start.', required_denials: revoked(2), allowed_after_cut: [], retained_before_cut: [] },
  'active-session': { purpose: 'Session-scope cut before any start covers every authority of the session.', required_denials: revoked(1, 2), allowed_after_cut: [], retained_before_cut: [] },
  'session-in-flight-commit-fence': { purpose: 'Session-scope cut while an execution is running: its commit is fenced, a running execution in another session of the tenant continues.', required_denials: revoked(3), allowed_after_cut: [4, 5, 6, 7], retained_before_cut: [0, 1] },
  'session-delivery-fence-after-commit': { purpose: 'Commit before a session-scope cut stays historical; delivery after the cut is fenced while the commit already exists.', required_denials: revoked(3), allowed_after_cut: [4], retained_before_cut: [1] },
  'tenant-multi-session-in-flight': { purpose: 'Tenant cut with running executions in two sessions of the tenant fences both commits; the other tenant continues.', required_denials: revoked(4, 5), allowed_after_cut: [6, 7, 8, 9, 10], retained_before_cut: [0, 1, 2] },
  'start-before-cut': { purpose: 'Race ordering pair with cut-before-start: the start linearizes before the cut, its commit after.', required_denials: revoked(2), allowed_after_cut: [3], retained_before_cut: [0] },
  'in-flight-before-commit': { purpose: 'Running execution cut before commit; cancellation receipt is not termination; delivery is overdetermined by the missing commit.', required_denials: revoked(3), allowed_after_cut: [2, 5], retained_before_cut: [0] },
  'late-commit-after-terminal': { purpose: 'Commit and delivery attempts after the finish request are denied (overdetermined: revoked and finish requested).', required_denials: [{ step: 3, reasons: ['revoked', 'finish_requested'] }], allowed_after_cut: [2], retained_before_cut: [0] },
  'retry-after-revocation': { purpose: 'Retry with a fresh ID after the cut on a consumed permit. Deliberately overdetermined single-use control; the revocation fence is covered by issued-permit and fresh-id-retry-unused-permit.', required_denials: [{ step: 3, reasons: ['revoked', 'permit_consumed'] }], allowed_after_cut: [2], retained_before_cut: [0] },
  'in-flight-after-commit': { purpose: 'Commit before the cut stays historical; delivery after the cut is fenced while the commit exists.', required_denials: revoked(4), allowed_after_cut: [3, 6], retained_before_cut: [1] },
  'commit-before-cut': { purpose: 'Commit and delivery before the cut are retained; finish remains allowed after it.', required_denials: [], allowed_after_cut: [4], retained_before_cut: [1, 2] },
  'commit-shift-across-cut': { purpose: 'A commit expected before the cut must be observed at that step; the same commit observed after the cut is detectable.', required_denials: [], allowed_after_cut: [3, 4], retained_before_cut: [1] },
  'cancel-is-not-rollback': { purpose: 'Cancellation and finish after a historical commit neither erase it nor permit delivery.', required_denials: [{ step: 5, reasons: ['revoked', 'finish_requested'] }], allowed_after_cut: [3, 4], retained_before_cut: [1] },
  'derived-authority': { purpose: 'Ancestor cut fences an issued child and a pending grandchild approval.', required_denials: revoked(1, 2), allowed_after_cut: [], retained_before_cut: [] },
  'derived-in-flight-ancestor-revoked': { purpose: 'Ancestor cut while a derived authority has a running execution fences its commit.', required_denials: revoked(2), allowed_after_cut: [3], retained_before_cut: [0] },
  'sibling-isolation': { purpose: 'Child cut leaves its sibling and its parent usable.', required_denials: revoked(1), allowed_after_cut: [2, 3, 4, 5, 7, 8], retained_before_cut: [] },
  'session-isolation': { purpose: 'Session cut leaves another session of the same tenant usable.', required_denials: revoked(1), allowed_after_cut: [2, 3, 4, 5], retained_before_cut: [] },
  'tenant-isolation': { purpose: 'Tenant cut leaves another tenant usable.', required_denials: revoked(1), allowed_after_cut: [2, 3, 4, 5], retained_before_cut: [] },
  'execution-id-reuse': { purpose: 'A running execution ID cannot be started, committed or finished by another authority whose own permit is unused.', required_denials: [{ step: 1, reasons: ['execution_id_in_use'] }, { step: 2, reasons: ['unbound_execution'] }, { step: 3, reasons: ['unbound_execution'] }], allowed_after_cut: [], retained_before_cut: [] },
  'permit-single-use': { purpose: 'Positive control without revocation: a permit starts one execution only.', required_denials: [{ step: 1, reasons: ['permit_consumed'] }], allowed_after_cut: [], retained_before_cut: [] },
  'approval-before-cut': { purpose: 'Positive control: the full lifecycle before a late cut is retained.', required_denials: [], allowed_after_cut: [], retained_before_cut: [0, 1, 2, 3, 4, 5] },
  'deferred-terminal-before-seal': { purpose: 'Permitted finish whose terminal evidence completes after the request but before the seal; commit after the finish request is denied.', required_denials: [{ step: 4, reasons: ['revoked', 'finish_requested'] }], allowed_after_cut: [2, 3], retained_before_cut: [0] },
};
