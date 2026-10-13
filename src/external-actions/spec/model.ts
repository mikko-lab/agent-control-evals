/**
 * External Action Boundary Evaluation, P1a: case and observation model
 * (docs/external-actions/evaluation-plan.md §5-§7, decisions in docs/external-actions/decisions.md).
 *
 * P1a evaluates fixed synthetic observations. No guard, double or network runs in this phase.
 */
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';

export const VERSION = 'external-actions-0.1.0';
export const OBSERVATION_FORMAT = 'external-action-observation/1';
export const PROFILE_FORMAT = 'external-action-profile/1';
export const GENESIS = '0'.repeat(64);

export type Recipient = 'P' | 'Q';
export const RECIPIENTS: readonly Recipient[] = ['P', 'Q'];
export type Route = 'form_tool' | 'http_tool';
/** What the attempt asks the recipient to do. `autosave_submit` is a submission sent through the autosave endpoint. */
export type Action = 'fill' | 'submit' | 'autosave_submit' | 'connect_only';
/** Authorization class of an action: a submission through the autosave path is a submission. */
export type ActionClass = 'fill' | 'submit' | 'connect';
export const actionClass = (a: Action): ActionClass => a === 'fill' ? 'fill' : a === 'connect_only' ? 'connect' : 'submit';
/** Conditions the harness induces for an attempt (plan §5.7). */
export type HarnessCondition = 'guard_timeout_after_forward' | 'guard_timeout_before_forward' | 'delay_element';
/** How a double handles submissions: store at once, store later in a background job, or reject every one (P failing, A2). */
export type RecipientMode = 'immediate' | 'deferred_persist' | 'failing';

export interface FormDef { form_id: string; recipient: Recipient; autosave: boolean; excluded_fields: string[] }
export interface Attempt {
  id: string;
  route: Route;
  recipient: Recipient;
  action: Action;
  form_id: string;
  /** Submitted fields, including fields the form excludes from the logical identity. */
  fields: Record<string, string>;
  /** Attempts that name the same label share one keep-alive connection. */
  connection: string;
  conditions: HarnessCondition[];
}
export interface Grant { recipient: Recipient; actions: ActionClass[] }
export interface CaseDef {
  id: string;
  scenario: string;
  role: 'witness' | 'control';
  /** The allowed control whose PASS keeps this case from being vacuous (a control names itself). */
  control: string;
  grants: Grant[];
  forms: FormDef[];
  recipient_modes: Record<Recipient, RecipientMode>;
  per_attempt_identity: boolean;
  attempts: Attempt[];
  proving_mutants: string[];
  does_not_show: string;
}

/** Canonical digest of the user fields: excluded fields (tokens, client timestamps) are left out. */
export function contentDigest(form: FormDef, fields: Record<string, string>): string {
  const user: Record<string, string> = {};
  for (const k of Object.keys(fields).sort()) if (!form.excluded_fields.includes(k)) user[k] = fields[k];
  return sha256Hex(canonicalJson(user));
}
/** `logical_id = sha256(form_id ‖ canonical digest of the submitted user fields)` (plan §5.7, D7). */
export const logicalId = (formId: string, digest: string) => sha256Hex(`${formId}\u0000${digest}`);
export const formOf = (c: CaseDef, formId: string): FormDef => {
  const f = c.forms.find(x => x.form_id === formId);
  if (!f) throw new Error(`case ${c.id}: unknown form ${formId}`);
  return f;
};

// ---- Observation (external-action-observation/1) ----

export type Decision = 'ALLOW' | 'DENY' | 'UNKNOWN';
export type EntryKind = 'connection_accepted' | 'request_received' | 'submit_received' | 'submit_rejected' | 'submit_stored' | 'draft_stored' | 'fence';
export interface EntryBase { seq: number; prev: string; hash: string; kind: EntryKind; mono_us: number }
export interface ConnectionEntry extends EntryBase { kind: 'connection_accepted'; peer: string; connection_id: string }
export interface RequestEntry extends EntryBase {
  kind: 'request_received'; peer: string; connection_id: string; request_index: number;
  method: string; host: string; path: string; local_address: string;
  action_class: 'fill' | 'autosave' | 'submit' | 'other'; content_digest: string | null;
}
export interface SubmitReceivedEntry extends EntryBase { kind: 'submit_received'; request_seq: number; logical_id: string; content_digest: string }
export interface SubmitRejectedEntry extends EntryBase { kind: 'submit_rejected'; received_seq: number; reason: string }
export interface SubmitStoredEntry extends EntryBase { kind: 'submit_stored'; received_seq: number; record_id: string; logical_id: string; deferred: boolean; before_digest: string; after_digest: string }
export interface DraftStoredEntry extends EntryBase { kind: 'draft_stored'; request_seq: number; form_id: string; content_digest: string; before_digest: string; after_digest: string }
export interface FenceEntry extends EntryBase { kind: 'fence'; fence_id: string }
export type Entry = ConnectionEntry | RequestEntry | SubmitReceivedEntry | SubmitRejectedEntry | SubmitStoredEntry | DraftStoredEntry | FenceEntry;

/** Hash of a journal entry: sha256 over its canonical JSON without the `hash` member (`prev` included). */
export function entryHash(e: Omit<Entry, 'hash'> | Entry): string {
  const { hash: _hash, ...rest } = e as Entry;
  return sha256Hex(canonicalJson(rest));
}

export interface DraftRecord { form_id: string; digest: string }
export interface SubmissionRecord { record_id: string; logical_id: string; content_digest: string }
/** A double's application state (D9): counters, draft records and submission records. */
export interface RecipientState { connections: number; requests: number; drafts: DraftRecord[]; submissions: SubmissionRecord[] }
export type States = Record<Recipient, RecipientState>;

export interface Tracker { open_connections: number; running_handlers: number; queued_jobs: number; pending_writes: number }

export type WindowFailure = 'fence_missing' | 'connections_open';
export interface AttemptObservation {
  id: string;
  status: 'issued' | 'not_issued_after_window_failure';
  /** Harness-assigned per-attempt network identity, or null when the case has none. */
  network_identity: string | null;
  decision: Decision | null;
  /** The agent's own account. Recorded, never evidence. */
  agent_claim: 'submitted' | 'not_submitted' | null;
  window: null | {
    status: 'closed' | 'failed';
    failure_reason: WindowFailure | null;
    fence_id: string;
    elapsed_ms: number;
    /** The one-way closure signal of this window was sent to the executor. */
    signal_sent: boolean;
  };
}

export interface ExecutorQuiescence {
  status: 'natural' | 'timeout_killed' | 'not_started';
  cgroup_populated: boolean | null;
  natural_exit: boolean | null;
  killed: boolean;
  elapsed_ms: number | null;
  /** What the recipients showed at the moment executor quiescence was confirmed (diagnostic; deferred work still pending). */
  recipient_view: null | { journal_seq: Record<Recipient, number>; states: States };
}
export interface RecipientQuiescence {
  status: 'observed' | 'timeout' | 'not_started';
  elapsed_ms: number | null;
  trackers: Record<Recipient, Tracker> | null;
  netem_backlog_packets: number | null;
}
export interface FenceStep { status: 'present' | 'missing' | 'not_started'; fence_id: string }
export interface SnapshotStep { status: 'taken' | 'failed' | 'not_started'; states: States | null }
export interface FinalClosure {
  confirmed: boolean;
  failure_reason: string | null;
  steps: {
    executor_quiescence: ExecutorQuiescence;
    guard_queue: { reported: boolean; empty: boolean | null };
    recipient_quiescence: RecipientQuiescence;
    final_fence: FenceStep;
    final_snapshots: SnapshotStep;
  };
}
export interface PostCleanupCollection {
  trigger: 'window_failure' | 'executor_timeout';
  cgroup_kill: boolean;
  recipient_quiescence: RecipientQuiescence;
  fence: FenceStep;
  snapshots: SnapshotStep;
}
export interface Observation {
  format: typeof OBSERVATION_FORMAT;
  case_id: string;
  /** `synthetic_fixture` (P1a) or `local_doubles` (P1b: recorded by the harness from the local doubles). */
  source: 'synthetic_fixture' | 'local_doubles';
  timing: Timing;
  isolation: { canary_probe_blocked: boolean; canary_hits: number; config_before_sha256: string; config_after_sha256: string };
  /** Harness delay element (retry-delayed): the attempt whose traffic it held and for how long. */
  delay_element: null | { attempt: string; delay_ms: number };
  attempts: AttemptObservation[];
  journals: Record<Recipient, Entry[] | null>;
  snapshots: { baseline: States; provisional: { fence_id: string; states: States }[] };
  final_closure: FinalClosure;
  post_cleanup_collection: PostCleanupCollection | null;
}
export interface Timing { T_w_ms: number; T_q_ms: number; T_r_ms: number }

// ---- Profile ----
export interface Profile {
  format: typeof PROFILE_FORMAT;
  profile_id: string;
  corpus_sha256: string;
  timing: Timing & { xm13a_delay_ms: number; xm13b_delay_ms: number; deferred_persist_ms: number };
  cases: string[];
}

// ---- Expectations (oracle) and evidence (evaluator) ----
export type ExpectedDecision = Decision;
export interface ExpectedAttempt { attempt: string; decision: ExpectedDecision; forwarded: boolean; content_digest: string | null; logical_id: string | null }
/** Effects a forwarded attempt is expected to leave at its recipient. */
export interface AttemptContribution { attempt: string; recipient: Recipient; connection: string | null; request: boolean; draft: { form_id: string; digest: string } | null; submission: string | null }
export interface Expected {
  case_id: string;
  attempts: ExpectedAttempt[];
  contributions: AttemptContribution[];
  /** Forms per recipient (for draft requirements). */
  forms: Record<Recipient, string[]>;
  /** Recipients whose submissions are rejected by mode (A2): no record is expected there from any attempt. */
  rejecting: Recipient[];
}

export type DecisionFinding = 'false_allow' | 'false_deny';
export type EffectFinding =
  | 'unexpected_connection_accepted' | 'missing_connection_accepted'
  | 'unexpected_request_received' | 'missing_request_received'
  | 'unexpected_draft_saved' | 'missing_draft_saved'
  | 'unexpected_submission_received' | 'submission_duplicate' | 'missing_submission_received'
  | 'unattributed_effect';
export type Verdict = 'PASS' | 'VIOLATION' | 'UNASSESSABLE' | 'HARNESS_ERROR';
export type AttributionLevel = 'attributed' | 'content_matched' | 'ambiguous_origin' | 'unattributed';
export interface Attribution { level: AttributionLevel; attempts: string[] }
export interface EffectItem {
  recipient: Recipient;
  class: 'connection_accepted' | 'request_received' | 'draft_saved' | 'submission_received';
  ref: string;
  attribution: Attribution;
  late: boolean | null;
}
export interface Finding { requirement: string; reason: DecisionFinding | EffectFinding; attempt: string | null; recipient: Recipient | null; detail: string; refs: string[]; late: boolean }
export interface Incomplete { requirement: string; reason: string; flag: 'contradictory' | 'ambiguous_origin' | 'closure' | 'decision_unknown' | 'journal' }
export interface NotAssessed { requirement: string; attempt: string; reason: 'not_issued_after_window_failure' }
export interface HarnessErrorItem { code: string; path: string; message: string }
export interface Evidence {
  case_id: string;
  scenario: string;
  role: 'witness' | 'control';
  verdict: Verdict;
  confirmed_violation: boolean;
  decision_findings: Finding[];
  effect_findings: Finding[];
  incomplete: Incomplete[];
  not_assessed: NotAssessed[];
  errors: HarnessErrorItem[];
  effects: EffectItem[];
  closure: { final_confirmed: boolean; recipients_confirmed: Record<Recipient, boolean>; notes: string[]; post_cleanup_used: boolean };
}
