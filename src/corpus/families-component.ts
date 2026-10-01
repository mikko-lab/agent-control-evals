import type { VariantDef } from "./variant";
import { APPROVER, ordinaryOutput, validGrant } from "./builders";
import type { PermitScenario, VerifierScenario } from "./types";

const ctx = (session: string, request: string) => ({ session, request, tool: "update_record", approver_id: APPROVER });

function verifier(grant: VerifierScenario["grant"], context: VerifierScenario["context"]): VerifierScenario {
  return { kind: "component", component: "approval_grant_verifier", grant, context };
}

const P = { step: 0, stage: "verifier" as const };

export const approvalVerifierRequestBinding: VariantDef[] = [
  { name: "request_mismatch", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s1", "q2"), ctx("s1", "q1")), primary: P }) },
  { name: "request_mismatch_other_label_space", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s1", `x${rng.int(1, 99)}`), ctx("s1", "q1")), primary: P }) },
  { name: "request_and_session_mismatch", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s2", "q2"), ctx("s1", "q1")), primary: P }) },
  { name: "request_tampered_after_signing", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s1", "q2", { tamper: { field: "request", value: "q1" } }), ctx("s1", "q1")), primary: P }) },
  { name: "positive_request_match", adversarial: false, intent: "ACCEPT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s1", "q1"), ctx("s1", "q1")), primary: P }) },
];

export const approvalVerifierSessionBinding: VariantDef[] = [
  { name: "session_mismatch", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s2", "q1"), ctx("s1", "q1")), primary: P }) },
  { name: "session_mismatch_other_label_space", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, `t${rng.int(1, 99)}`, "q1"), ctx("s1", "q1")), primary: P }) },
  { name: "session_and_request_mismatch", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s2", "q2"), ctx("s1", "q1")), primary: P }) },
  { name: "session_tampered_after_signing", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s2", "q1", { tamper: { field: "session", value: "s1" } }), ctx("s1", "q1")), primary: P }) },
  { name: "positive_session_match", adversarial: false, intent: "ACCEPT", build: (rng) => ({ scenario: verifier(validGrant(rng, "s1", "q1"), ctx("s1", "q1")), primary: P }) },
];

function permit(rng: import("../util/rng").Rng, attempts: number, concurrent: boolean, forged = false, mismatch?: "tool" | "request" | "session"): PermitScenario {
  const tool = rng.pick(["read_record", "update_record"]);
  const p = { session: "s1", request: "q1", tool, forged };
  const at = Array.from({ length: attempts }, () => ({ session: "s1", request: "q1", tool }));
  if (mismatch === "tool") at[0].tool = tool === "read_record" ? "update_record" : "read_record";
  if (mismatch === "request") at[0].request = "q2";
  if (mismatch === "session") at[0].session = "s2";
  return { kind: "component", component: "execution_gate", permit: p, attempts: at, concurrent, tool_output: ordinaryOutput(rng) };
}

const PP = { step: 0, stage: "permit" as const };

export const executionPermitSingleUse: VariantDef[] = [
  { name: "sequential_reuse_x2", adversarial: true, intent: "REUSE_BLOCKED", build: (rng) => ({ scenario: permit(rng, 2, false), primary: PP }) },
  { name: "sequential_reuse_x3", adversarial: true, intent: "REUSE_BLOCKED", build: (rng) => ({ scenario: permit(rng, 3, false), primary: PP }) },
  { name: "concurrent_reuse_x2", adversarial: true, intent: "REUSE_BLOCKED", build: (rng) => ({ scenario: permit(rng, 2, true), primary: PP }) },
  { name: "concurrent_reuse_x4", adversarial: true, intent: "REUSE_BLOCKED", build: (rng) => ({ scenario: permit(rng, 4, true), primary: PP }) },
  { name: "forged_permit", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: permit(rng, 1, false, true), primary: PP }) },
  { name: "permit_binding_mismatch", adversarial: true, intent: "REJECT", build: (rng) => ({ scenario: permit(rng, 1, false, false, rng.pick(["tool", "request", "session"] as const)), primary: PP }) },
  { name: "positive_single_execution", adversarial: false, intent: "EXECUTE_ONCE", build: (rng) => ({ scenario: permit(rng, 1, false), primary: PP }) },
];
