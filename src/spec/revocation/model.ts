export const VERSION = 'revocation-0.4.0';
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

/**
 * revocation-0.4.0 runtime-adapter observations (docs/revocation/runtime-adapter-compatibility.md, sections 3.6 and 4).
 * The 0.3.0 observation shape above stays the format of the synthetic and imported paths; a pinned runtime adapter
 * additionally reports provenance, a probe-bound sequence index per effect, its probe log and its API call records.
 */
export const PROVENANCE = ['sut_api', 'sut_state', 'harness_observation'] as const;
export type Provenance = typeof PROVENANCE[number];
export const PROBE_POINTS = ['pre_action', 'tool_entry', 'event', 'barrier_complete', 'seal_settle'] as const;
export type ProbePoint = typeof PROBE_POINTS[number];
/** Probe points at which a first-observed effect lies outside every step barrier (drift). */
export const DRIFT_POINTS: readonly ProbePoint[] = ['pre_action', 'seal_settle'];
/** Runtime identities, mapped back to contract identities by the declared identity mapping. */
export type RuntimeTarget = { scope: 'capability'; capability_id: string } | { scope: 'session'; session_id: string };
export interface IdentityMapping {
  /** runtime capability_id -> contract authority */
  capabilities: Record<string, string>;
  /** runtime session_id -> contract (tenant, session) pair */
  sessions: Record<string, { tenant: string; session: string }>;
}
/** Raw observable state at one probe. Effects are derived from it by src/spec/revocation/runtime-observation.ts. */
export interface ProbeState {
  receipts: { step: number; target: RuntimeTarget }[];
  /** Tool-double invocations: contract execution label and the authority named by the request marker. */
  entries: { label: string; execution_id: string; request_authority: string }[];
  /** Runtime execution records (getExecution) of every invocation seen so far. */
  executions: { label: string; execution_id: string; capability_id: string; session_id: string; state: string; cancellation_acknowledged: boolean }[];
  /** Managed-state keys written so far, with the execution label and commit attempt they belong to. */
  managed: { key: string; label: string; n: number }[];
  /** Public promises fulfilled with a successful result carrying the execution's output nonce. */
  deliveries: { label: string }[];
}
export interface Probe { index: number; step: number; point: ProbePoint; state: ProbeState }
export type CallApi = 'revoke' | 'process' | 'resolveApproval' | 'commit' | 'deliver' | 'acknowledgeCancellation';
/**
 * Raw outcome of the SUT call of one step. `class` names the SUT error class an exception was an instance of
 * (AuthorityRevokedError, CommitRejectedError, RevocationTargetError) or `other:<name>`.
 */
export interface CallRecord {
  step: number;
  api: CallApi;
  outcome: 'returned' | 'threw' | 'tool_invoked' | 'fulfilled' | 'rejected' | 'timeout';
  class?: string;
  /** cancel_ack: the boolean returned; deliver: delivered | withheld_revoked | other. */
  value?: boolean | string;
}
export interface Diagnostic { step: number | null; code: string; detail: string }
export interface RuntimeDecision extends Decision { provenance: Provenance[] }
export interface RuntimeEffect extends Effect { seq: number; provenance: Provenance[] }
export interface RuntimeObservation {
  case_id: string;
  complete: boolean;
  decisions: RuntimeDecision[];
  effects: RuntimeEffect[];
  identity: IdentityMapping;
  probes: Probe[];
  calls: CallRecord[];
  diagnostics: Diagnostic[];
}
