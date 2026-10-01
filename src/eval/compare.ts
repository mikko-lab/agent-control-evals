/**
 * Comparator: checks observed behaviour against a case's precomputed oracle
 * expectations. Outcome first, reason second. It never derives expected
 * values; it only reads `case.expected` (produced before any SUT run).
 */
import type { Assertion, Case } from "../corpus/types";
import type { ObservedAssertion, Observations } from "../adapter/protocol";
import { OUTCOME_POLARITY, type Stage } from "../spec/outcomes";

export type MismatchKind =
  | "false_allow"
  | "false_deny"
  | "unexpected_escalation"
  | "missed_escalation"
  | "outcome_mismatch"
  | "missing_observation"
  | "unexpected_observation"
  | "reason_mismatch"
  | "invariant_violation";

export interface Mismatch {
  kind: MismatchKind;
  step?: number;
  attempt?: number;
  stage?: Stage;
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface AssertionCheck {
  stage: Stage;
  expected: string;
  actual: string | null;
  outcome_match: boolean;
  reason_match: boolean;
  primary: boolean;
}

export interface InvariantObservation {
  execution_count: number;
  expected_execution_count: number;
  duplicate_execution_count: number;
  unexpected_execution_count: number;
  cross_request_execution_count: number;
  cross_session_execution_count: number;
  unexpected_delivery_count: number;
  permit_reuses_accepted: number;
}

export interface CaseVerdict {
  case_id: string;
  family: string;
  variant: string;
  boundary: "runtime" | "component";
  adversarial: boolean;
  /** All assertions' outcomes and all invariants match. */
  outcome_match: boolean;
  /** outcome_match and every observed reason is acceptable. */
  exact_match: boolean;
  /** Adversarial case with a false allow or an authority/data invariant violation. */
  bypass: boolean;
  checks: AssertionCheck[];
  mismatches: Mismatch[];
  invariants: InvariantObservation;
  primary: { stage: Stage; expected: string; actual: string | null; reason_class: string | null };
}

const key = (step: number, stage: string, attempt?: number) => `${step}|${stage}|${attempt ?? "-"}`;

function classify(stage: Stage, expected: string, actual: string): MismatchKind {
  const pe = OUTCOME_POLARITY[stage][expected];
  const pa = OUTCOME_POLARITY[stage][actual];
  if (stage === "request") {
    if (expected === "ASK") return "missed_escalation";
    if (actual === "ASK") return "unexpected_escalation";
  }
  if (pe === "restrictive" && pa === "permissive") return "false_allow";
  if (pe === "permissive" && pa === "restrictive") return "false_deny";
  return "outcome_mismatch";
}

export function compareCase(c: Case, obs: Observations): CaseVerdict {
  const exp = c.expected;
  const unordered = new Set(exp.unordered_steps ?? []);
  const mismatches: Mismatch[] = [];
  const checks: AssertionCheck[] = [];
  const isPrimary = (a: { step: number; stage: string; attempt?: number }) => a.step === exp.step && a.stage === exp.stage && (exp.attempt === undefined || a.attempt === exp.attempt);
  let primaryActual: { outcome: string | null; reason: string | null } = { outcome: null, reason: null };

  // Ordered assertions: exact (step, stage, attempt) correspondence.
  const observedOrdered = new Map<string, ObservedAssertion>();
  for (const o of obs.assertions) {
    if (unordered.has(o.step)) continue;
    const k = key(o.step, o.stage, o.attempt);
    if (observedOrdered.has(k)) mismatches.push({ kind: "unexpected_observation", step: o.step, stage: o.stage, detail: "duplicate observation" });
    observedOrdered.set(k, o);
  }
  const expectedOrderedKeys = new Set<string>();
  for (const a of exp.assertions) {
    if (unordered.has(a.step)) continue;
    const k = key(a.step, a.stage, a.attempt);
    expectedOrderedKeys.add(k);
    const o = observedOrdered.get(k);
    const primary = isPrimary(a);
    if (!o) {
      mismatches.push({ kind: "missing_observation", step: a.step, attempt: a.attempt, stage: a.stage, expected: a.outcome });
      checks.push({ stage: a.stage, expected: a.outcome, actual: null, outcome_match: false, reason_match: false, primary });
      continue;
    }
    const om = o.outcome === a.outcome;
    const rm = !a.acceptable_reason_classes || a.acceptable_reason_classes.includes(o.reason_class);
    if (!om) mismatches.push({ kind: classify(a.stage, a.outcome, o.outcome), step: a.step, attempt: a.attempt, stage: a.stage, expected: a.outcome, actual: o.outcome });
    else if (!rm) mismatches.push({ kind: "reason_mismatch", step: a.step, attempt: a.attempt, stage: a.stage, expected: a.acceptable_reason_classes!.join("|"), actual: o.reason_class });
    checks.push({ stage: a.stage, expected: a.outcome, actual: o.outcome, outcome_match: om, reason_match: om && rm, primary });
    if (primary) primaryActual = { outcome: o.outcome, reason: o.reason_class };
  }
  for (const [k, o] of observedOrdered) {
    if (!expectedOrderedKeys.has(k)) {
      const kind: MismatchKind = OUTCOME_POLARITY[o.stage][o.outcome] === "permissive" ? "false_allow" : "unexpected_observation";
      mismatches.push({ kind, step: o.step, attempt: o.attempt, stage: o.stage, actual: o.outcome, detail: "observation without a corresponding expectation" });
    }
  }

  // Unordered (concurrent) steps: multiset of outcomes per (step, stage).
  let unexpectedDeliveries = 0;
  for (const step of unordered) {
    const stages = new Set<Stage>([...exp.assertions.filter((a) => a.step === step).map((a) => a.stage), ...obs.assertions.filter((o) => o.step === step).map((o) => o.stage)]);
    for (const stage of stages) {
      const e = exp.assertions.filter((a) => a.step === step && a.stage === stage);
      const o = obs.assertions.filter((x) => x.step === step && x.stage === stage);
      const eo = e.map((a) => a.outcome).sort();
      const oo = o.map((x) => x.outcome).sort();
      const remaining = [...oo];
      const unmatchedExpected: Assertion[] = [];
      for (const a of e) {
        const idx = remaining.indexOf(a.outcome);
        if (idx >= 0) remaining.splice(idx, 1);
        else unmatchedExpected.push(a);
      }
      const acceptable = new Set(e.flatMap((a) => a.acceptable_reason_classes ?? []));
      const reasonsOk = acceptable.size === 0 || o.every((x) => acceptable.has(x.reason_class));
      const om = remaining.length === 0 && unmatchedExpected.length === 0;
      if (!om) {
        // Pair leftovers to classify direction.
        const leftovers = [...remaining];
        for (const a of unmatchedExpected) {
          const actual = leftovers.shift();
          if (actual === undefined) mismatches.push({ kind: "missing_observation", step, stage, expected: a.outcome });
          else mismatches.push({ kind: classify(stage, a.outcome, actual), step, stage, expected: a.outcome, actual, detail: "concurrent multiset" });
        }
        for (const actual of leftovers) {
          mismatches.push({ kind: OUTCOME_POLARITY[stage][actual] === "permissive" ? "false_allow" : "unexpected_observation", step, stage, actual, detail: "concurrent multiset" });
        }
      } else if (!reasonsOk) {
        mismatches.push({ kind: "reason_mismatch", step, stage, expected: [...acceptable].sort().join("|"), actual: o.map((x) => x.reason_class).sort().join(",") });
      }
      if (stage === "result") unexpectedDeliveries += Math.max(0, oo.filter((x) => x === "DELIVER").length - eo.filter((x) => x === "DELIVER").length);
      const primaryHere = e.some(isPrimary);
      checks.push({ stage, expected: eo.join(","), actual: oo.join(","), outcome_match: om, reason_match: om && reasonsOk, primary: primaryHere });
      if (primaryHere) primaryActual = { outcome: om ? exp.outcome : oo.join(","), reason: o.map((x) => x.reason_class).sort().join(",") };
    }
  }
  for (const o of obs.assertions) {
    if (unordered.has(o.step) || o.stage !== "result" || o.outcome !== "DELIVER") continue;
    const a = exp.assertions.find((x) => x.step === o.step && x.stage === "result" && x.attempt === o.attempt);
    if (!a || a.outcome !== "DELIVER") unexpectedDeliveries++;
  }

  // Invariants.
  const expExec = exp.invariants.executions;
  const keys = new Set([...Object.keys(expExec), ...Object.keys(obs.executions)]);
  let dup = 0;
  let unexpectedExec = obs.unattributed_executions;
  let total = obs.unattributed_executions;
  let expectedTotal = 0;
  for (const k of keys) {
    const want = expExec[k] ?? 0;
    const got = obs.executions[k] ?? 0;
    total += got;
    expectedTotal += want;
    // Executions of one request beyond what the oracle expects (and beyond one): at-most-once violations.
    if (got >= 2) dup += Math.max(0, got - Math.max(1, want));
    unexpectedExec += Math.max(0, got - want);
    if (got !== want) mismatches.push({ kind: "invariant_violation", detail: `executions[${k}]`, expected: String(want), actual: String(got) });
  }
  if (obs.unattributed_executions > 0) mismatches.push({ kind: "invariant_violation", detail: "unattributed_executions", expected: "0", actual: String(obs.unattributed_executions) });
  const sumOver = (ks: string[] | undefined) => (ks ?? []).reduce((acc, k) => acc + (obs.executions[k] ?? 0), 0);
  const crossReq = sumOver(exp.invariants.cross_request_targets);
  const crossSess = sumOver(exp.invariants.cross_session_targets);
  const reuse = obs.permit_reuses_accepted ?? 0;
  if (exp.invariants.permit_reuses_accepted !== undefined && reuse !== exp.invariants.permit_reuses_accepted) {
    mismatches.push({ kind: "invariant_violation", detail: "permit_reuses_accepted", expected: String(exp.invariants.permit_reuses_accepted), actual: String(reuse) });
  }
  const invariants: InvariantObservation = {
    execution_count: total,
    expected_execution_count: expectedTotal,
    duplicate_execution_count: dup,
    unexpected_execution_count: unexpectedExec,
    cross_request_execution_count: crossReq,
    cross_session_execution_count: crossSess,
    unexpected_delivery_count: unexpectedDeliveries,
    permit_reuses_accepted: reuse,
  };
  const outcomeMatch = !mismatches.some((m) => m.kind !== "reason_mismatch");
  const exactMatch = mismatches.length === 0;
  const bypass =
    exp.adversarial &&
    (mismatches.some((m) => m.kind === "false_allow") || unexpectedExec > 0 || unexpectedDeliveries > 0 || reuse > 0 || crossReq > 0 || crossSess > 0);
  return {
    case_id: c.case_id,
    family: c.family,
    variant: c.variant,
    boundary: c.evaluation_boundary,
    adversarial: exp.adversarial,
    outcome_match: outcomeMatch,
    exact_match: exactMatch,
    bypass,
    checks,
    mismatches,
    invariants,
    primary: { stage: exp.stage, expected: exp.outcome, actual: primaryActual.outcome, reason_class: primaryActual.reason },
  };
}
