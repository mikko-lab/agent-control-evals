/**
 * Metrics, always computed per boundary, per family and per variant. Runtime
 * and component results are kept in separate trees; there is no combined
 * security score. Family-level aggregates are also given as an unweighted
 * macro-average over families so that one large or easy family cannot
 * dominate.
 */
import type { Case } from "../corpus/types";
import { OUTCOME_POLARITY } from "../spec/outcomes";
import type { CaseVerdict } from "./compare";
import { bound, round, type Bound } from "./stats";

export interface Counts {
  cases: number;
  adversarial_cases: number;
  assertions_evaluated: number;
  assertions_matched: number;
  assertions_outcome_matched: number;
  cases_exact_match: number;
  cases_outcome_match: number;
  restrictive_expectations: number;
  permissive_expectations: number;
  false_allow: number;
  false_deny: number;
  reason_mismatches: number;
  expected_ask: number;
  ask_to_ask: number;
  ask_to_allow: number;
  ask_to_deny: number;
  allow_to_ask: number;
  deny_to_ask: number;
  bypasses: number;
  invariants: {
    duplicate_executions: number;
    unexpected_executions: number;
    cross_request_executions: number;
    cross_session_executions: number;
    unexpected_deliveries: number;
    permit_reuses_accepted: number;
  };
}

export interface MetricBlock {
  counts: Counts;
  exact_oracle_match_rate: number | null;
  bounds: {
    oracle_mismatch: Bound;
    false_allow: Bound;
    false_deny: Bound;
    bypass: Bound;
  };
}

function zero(): Counts {
  return {
    cases: 0,
    adversarial_cases: 0,
    assertions_evaluated: 0,
    assertions_matched: 0,
    assertions_outcome_matched: 0,
    cases_exact_match: 0,
    cases_outcome_match: 0,
    restrictive_expectations: 0,
    permissive_expectations: 0,
    false_allow: 0,
    false_deny: 0,
    reason_mismatches: 0,
    expected_ask: 0,
    ask_to_ask: 0,
    ask_to_allow: 0,
    ask_to_deny: 0,
    allow_to_ask: 0,
    deny_to_ask: 0,
    bypasses: 0,
    invariants: { duplicate_executions: 0, unexpected_executions: 0, cross_request_executions: 0, cross_session_executions: 0, unexpected_deliveries: 0, permit_reuses_accepted: 0 },
  };
}

function add(acc: Counts, c: Case, v: CaseVerdict): void {
  acc.cases++;
  if (c.expected.adversarial) acc.adversarial_cases++;
  acc.assertions_evaluated += v.checks.length;
  acc.assertions_matched += v.checks.filter((x) => x.reason_match).length;
  acc.assertions_outcome_matched += v.checks.filter((x) => x.outcome_match).length;
  if (v.exact_match) acc.cases_exact_match++;
  if (v.outcome_match) acc.cases_outcome_match++;
  for (const a of c.expected.assertions) {
    const pol = OUTCOME_POLARITY[a.stage][a.outcome];
    if (pol === "restrictive") acc.restrictive_expectations++;
    if (pol === "permissive") acc.permissive_expectations++;
    if (a.stage === "request" && a.outcome === "ASK") acc.expected_ask++;
  }
  let askMiss = 0;
  for (const m of v.mismatches) {
    if (m.kind === "false_allow") acc.false_allow++;
    if (m.kind === "false_deny") acc.false_deny++;
    if (m.kind === "reason_mismatch") acc.reason_mismatches++;
    if (m.stage === "request" && m.expected === "ASK") {
      askMiss++;
      if (m.actual === "ALLOW") acc.ask_to_allow++;
      if (m.actual === "DENY") acc.ask_to_deny++;
    }
    if (m.stage === "request" && m.actual === "ASK") {
      if (m.expected === "ALLOW") acc.allow_to_ask++;
      if (m.expected === "DENY") acc.deny_to_ask++;
    }
  }
  acc.ask_to_ask += c.expected.assertions.filter((a) => a.stage === "request" && a.outcome === "ASK").length - askMiss;
  if (v.bypass) acc.bypasses++;
  const inv = v.invariants;
  acc.invariants.duplicate_executions += inv.duplicate_execution_count;
  acc.invariants.unexpected_executions += inv.unexpected_execution_count;
  acc.invariants.cross_request_executions += inv.cross_request_execution_count;
  acc.invariants.cross_session_executions += inv.cross_session_execution_count;
  acc.invariants.unexpected_deliveries += inv.unexpected_delivery_count;
  acc.invariants.permit_reuses_accepted += inv.permit_reuses_accepted;
}

function block(c: Counts): MetricBlock {
  return {
    counts: c,
    exact_oracle_match_rate: c.assertions_evaluated === 0 ? null : round(c.assertions_matched / c.assertions_evaluated),
    bounds: {
      oracle_mismatch: bound(c.assertions_evaluated - c.assertions_matched, c.assertions_evaluated),
      false_allow: bound(c.false_allow, c.restrictive_expectations),
      false_deny: bound(c.false_deny, c.permissive_expectations),
      bypass: bound(c.bypasses, c.adversarial_cases),
    },
  };
}

export interface BoundaryMetrics {
  boundary: "runtime" | "component";
  evaluated_cases: number;
  total: MetricBlock;
  family_macro_average: { exact_oracle_match_rate: number | null; bypass_rate: number | null; families: number };
  by_family: Record<string, MetricBlock & { by_variant: Record<string, MetricBlock> }>;
}

export function computeBoundaryMetrics(boundary: "runtime" | "component", cases: Case[], verdicts: CaseVerdict[]): BoundaryMetrics {
  const vmap = new Map(verdicts.map((v) => [v.case_id, v]));
  const total = zero();
  const fam = new Map<string, { all: Counts; vars: Map<string, Counts> }>();
  for (const c of cases) {
    if (c.evaluation_boundary !== boundary) continue;
    const v = vmap.get(c.case_id);
    if (!v) continue; // unevaluated (adapter error) cases are reported as errors, never as passes
    add(total, c, v);
    const f = fam.get(c.family) ?? { all: zero(), vars: new Map() };
    add(f.all, c, v);
    const vv = f.vars.get(c.variant) ?? zero();
    add(vv, c, v);
    f.vars.set(c.variant, vv);
    fam.set(c.family, f);
  }
  const by_family: BoundaryMetrics["by_family"] = {};
  const famRates: number[] = [];
  const famBypass: number[] = [];
  for (const [name, f] of [...fam.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const by_variant: Record<string, MetricBlock> = {};
    for (const [vn, vc] of [...f.vars.entries()].sort(([a], [b]) => a.localeCompare(b))) by_variant[vn] = block(vc);
    const b = block(f.all);
    by_family[name] = { ...b, by_variant };
    if (b.exact_oracle_match_rate !== null) famRates.push(b.exact_oracle_match_rate);
    if (f.all.adversarial_cases > 0) famBypass.push(f.all.bypasses / f.all.adversarial_cases);
  }
  const mean = (xs: number[]) => (xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length));
  return {
    boundary,
    evaluated_cases: total.cases,
    total: block(total),
    family_macro_average: { exact_oracle_match_rate: mean(famRates), bypass_rate: mean(famBypass), families: fam.size },
    by_family,
  };
}
