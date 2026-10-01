import type { EvaluationBoundary } from "../spec/boundaries";
import type { Family } from "../spec/families";
import type { ReasonClass } from "../spec/reason-taxonomy";
import type { Stage } from "../spec/outcomes";

/**
 * Harness-owned case model. This is NOT the ACS wire schema: it describes an
 * evaluation scenario semantically, and the adapter materialises it into SUT
 * calls (UUIDs, signatures, envelopes).
 *
 * Labels ("s1", "q1") are opaque scenario identifiers; the adapter maps them
 * deterministically to SUT identifiers. Time is always an integer millisecond
 * offset relative to the case's frozen evaluation clock, never an absolute time.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type SigState = "valid" | "tampered";

export interface CapabilitySpec {
  present: boolean;
  agent?: string;
  session?: string; // session label
  allowed_tools?: string[];
  issued_offset_ms?: number;
  expires_offset_ms?: number;
  signature?: SigState;
}

export interface RequestStep {
  op: "request";
  /** request_id label; reusing a label in the same session = a replay. */
  request: string;
  session: string;
  agent: string;
  tool: string;
  timestamp_offset_ms: number;
  signature: SigState;
  capability: CapabilitySpec;
  /** Deterministic output of the harness tool test double if this request executes. */
  tool_output: Json;
}

export interface GrantSpec {
  version: 2;
  decision: "approve" | "reject";
  /** Values the approval authority signs. */
  session: string;
  request: string;
  tool: string;
  approver_id: string;
  issued_offset_ms: number;
  /** Optional post-signature rewrite (the signature then no longer covers the content). */
  tamper?: { field: "session" | "request" | "tool" | "approver_id"; value: string };
}

export interface ApproveStep {
  op: "approve";
  grant: GrantSpec;
}

export interface ConcurrentApproveStep {
  op: "concurrent_approve";
  grants: GrantSpec[];
}

export interface ConcurrentRequestStep {
  op: "concurrent_request";
  requests: Omit<RequestStep, "op">[];
}

export interface AdvanceClockStep {
  op: "advance_clock";
  ms: number;
}

export interface ClearSessionStep {
  op: "clear_session";
  session: string;
}

export type RuntimeStep =
  | RequestStep
  | ApproveStep
  | ConcurrentApproveStep
  | ConcurrentRequestStep
  | AdvanceClockStep
  | ClearSessionStep;

export interface RuntimeScenario {
  kind: "runtime";
  steps: RuntimeStep[];
}

export interface VerifierScenario {
  kind: "component";
  component: "approval_grant_verifier";
  grant: GrantSpec;
  /** Trusted expected context handed to the verifier. */
  context: { session: string; request: string; tool: string; approver_id: string };
}

export interface PermitScenario {
  kind: "component";
  component: "execution_gate";
  permit: { session: string; request: string; tool: string; forged: boolean };
  attempts: { session: string; request: string; tool: string }[];
  concurrent: boolean;
  tool_output: Json;
}

export type Scenario = RuntimeScenario | VerifierScenario | PermitScenario;

/** One oracle assertion about one stage of one step (or one sub-attempt of a concurrent step). */
export interface Assertion {
  step: number;
  /** For concurrent steps: index of the attempt. Omitted otherwise. */
  attempt?: number;
  stage: Stage;
  outcome: string;
  acceptable_reason_classes?: ReasonClass[];
}

/** Concurrency / authority invariants (all observed counts must equal these). */
export interface ExpectedInvariants {
  /** request label (session-qualified "s1/q1") -> exact expected number of tool executions. */
  executions: Record<string, number>;
  /** Component permit cases: number of accepted permit reuses (expected 0). */
  permit_reuses_accepted?: number;
  /** Request keys targeted by a cross-request attack (each must have 0 executions). */
  cross_request_targets?: string[];
  /** Request keys targeted by a cross-session attack (each must have 0 executions). */
  cross_session_targets?: string[];
}

export interface Expected {
  /** Primary assertion (also repeated in `assertions`). */
  step: number;
  attempt?: number;
  stage: Stage;
  outcome: string;
  acceptable_reason_classes?: ReasonClass[];
  /** Whether this case is an adversarial attempt (expected outcome restrictive). */
  adversarial: boolean;
  /** All assertions including the primary one, in step order. */
  assertions: Assertion[];
  invariants: ExpectedInvariants;
  /**
   * For concurrent steps where attempt order is not specified: the multiset
   * of expected outcomes per step (order-agnostic).
   */
  unordered_steps?: number[];
}

export interface Case {
  case_schema_version: string;
  case_id: string;
  family: Family;
  variant: string;
  evaluation_boundary: Exclude<EvaluationBoundary, "N/A">;
  scenario: Scenario;
  expected: Expected;
}

/** The view of a case that is sent to the adapter. `expected` is never sent. */
export type CaseForAdapter = Omit<Case, "expected">;
