export const VERSION = 'revocation-0.3.0';
export const EFFECTS = ['approval_granted', 'permit_issued', 'execution_started', 'tool_commit', 'output_delivery', 'revocation_ack', 'cancellation_ack', 'execution_terminal'] as const;
export type EffectKind = typeof EFFECTS[number];
/** Effects that must occur at their own command step; execution_terminal may complete later within its window. */
export const EXACT_STEP_EFFECTS: readonly EffectKind[] = ['approval_granted', 'permit_issued', 'execution_started', 'tool_commit', 'output_delivery', 'revocation_ack', 'cancellation_ack'];
/** Design intent of a scenario. It is not the authority state at the cut; that is derived by replay (StateAtCut). */
export const FAMILIES = ['pending_approval', 'issued_permit', 'active_session', 'in_flight_before_commit', 'in_flight_after_commit', 'descendant_scope', 'scope_isolation', 'identity', 'observation_timing', 'control'] as const;
export type Family = typeof FAMILIES[number];
/** Initial grant state of a predeclared authority. */
export type InitialGrant = 'pending' | 'issued';
export interface Authority { id: string; tenant: string; session: string; parent: string | null; initial: InitialGrant }
export type Target = { scope: 'authority'; id: string } | { scope: 'session'; tenant: string; session: string } | { scope: 'tenant'; tenant: string };
export type Step = { op: 'revoke'; target: Target } | { op: 'seal' } | { op: 'approve' | 'issue'; authority: string } | { op: 'start' | 'commit' | 'deliver' | 'cancel_ack' | 'finish'; authority: string; execution: string };
export interface Case { id: string; family: Family; authorities: Authority[]; steps: Step[] }
export type DecisionValue = 'ALLOW' | 'DENY' | 'UNKNOWN';
export interface Decision { step: number; decision: DecisionValue }
/** Observed effect at its occurrence step. A revocation_ack names the target it acknowledges; every other effect has target null. */
export interface Effect { step: number; kind: EffectKind; authority: string | null; execution: string | null; target: Target | null }
export interface Observation { case_id: string; decisions: Decision[]; effects: Effect[]; complete: boolean }
/** Expected effect with its admissible occurrence window (earliest = latest for exact-step effects). */
export interface ExpectedEffect { kind: EffectKind; authority: string | null; execution: string | null; target: Target | null; earliest: number; latest: number }
export type GrantState = 'pending' | 'approved' | 'issued' | 'consumed';
export type ExecutionPhase = 'running' | 'committed' | 'delivered' | 'finish_requested';
export interface StateAtCut {
  step: number;
  target: Target;
  authorities: { id: string; grant: GrantState; revoked: 'before_cut' | 'by_cut' | 'no'; executions: { id: string; phase: ExecutionPhase }[] }[];
}
export interface Rationale { step: number; reasons: string[] }
export interface Expected { decisions: { step: number; decision: 'ALLOW' | 'DENY' }[]; effects: ExpectedEffect[]; rationale: Rationale[]; cuts: StateAtCut[] }
export type Verdict = 'PASS' | 'VIOLATION' | 'UNASSESSABLE' | 'HARNESS_ERROR';
export interface Finding { reason: string; step: number }
export interface EvidenceError { code: string; path: string; message: string }
export interface Evidence {
  case_id: string;
  family: Family;
  state_at_cut: StateAtCut[];
  verdict: Verdict;
  /** True whenever confirmed decision or effect findings exist, including in a HARNESS_ERROR case. */
  confirmed_violation: boolean;
  decision_findings: Finding[];
  effect_findings: Finding[];
  incomplete: string[];
  errors: EvidenceError[];
}
