/**
 * Metrics, always per boundary, per family and per variant. Runtime and
 * component results live in separate trees; there is no combined security
 * score.
 *
 * Statistical unit (review B1): every metric that carries a confidence bound
 * is a proportion of SCENARIOS (cases), and its numerator only counts
 * scenarios that are members of its denominator (k <= n by construction).
 * Assertion-level counts are kept as descriptive counts and never get a bound,
 * because the assertions of one scenario are dependent.
 *
 * Evidence breadth (review B2): cases within a variant are seeded replicates
 * of one designed structure, so a defect usually affects all or none of them.
 * Variant coverage (how many designed variants exist / failed) is therefore
 * reported separately, without a bound, and is the breadth statistic.
 */
import type { Case } from "../corpus/types";
import { OUTCOME_POLARITY } from "../spec/outcomes";
import type { CaseVerdict } from "./compare";
import { bound, round, type Bound } from "./stats";

/** Scenario-level counts (unit: one case = one scenario). */
export interface ScenarioCounts {
  cases: number;
  adversarial_cases: number;
  /** Cases with at least one restrictive expected assertion (denominator of false_allow). */
  cases_with_restrictive_expectation: number;
  /** Cases whose PRIMARY expected outcome is permissive (denominator of false_deny). */
  cases_with_permissive_primary: number;
  cases_outcome_match: number;
  cases_exact_match: number;
  /** k of false_allow: members of cases_with_restrictive_expectation with a false allow or a permissive invariant violation. */
  false_allow_cases: number;
  /** k of false_deny: members of cases_with_permissive_primary whose primary observation was restrictive. */
  false_deny_cases: number;
  /** k of bypass: adversarial cases with a false allow or an authority/data invariant violation. */
  bypass_cases: number;
  /** Descriptive: cases outside the false_allow denominator that still showed a permissive deviation. */
  permissive_deviation_outside_denominator: number;
  decision_effect_mismatch_cases: number;
}

/** Assertion-level counts. DESCRIPTIVE ONLY: assertions within a scenario are dependent; no bounds. */
export interface AssertionCounts {
  assertions_evaluated: number;
  assertions_matched: number;
  assertions_outcome_matched: number;
  restrictive_expectations: number;
  permissive_expectations: number;
  false_allow_mismatches: number;
  false_deny_mismatches: number;
  reason_mismatches: number;
  decision_effect_mismatches: number;
  expected_ask: number;
  ask_to_ask: number;
  ask_to_allow: number;
  ask_to_deny: number;
  allow_to_ask: number;
  deny_to_ask: number;
}

export interface InvariantCounts {
  duplicate_executions: number;
  unexpected_executions: number;
  cross_request_executions: number;
  cross_session_executions: number;
  unexpected_deliveries: number;
  permit_reuses_accepted: number;
}

/** Variant coverage (unit: designed variant). No bounds. */
export interface VariantCoverage {
  variants: number;
  adversarial_variants: number;
  positive_variants: number;
  variants_with_outcome_failure: number;
  adversarial_variants_with_bypass: number;
  positive_variants_with_false_deny: number;
  /** cases / variants: how many seeded replicates stand behind each designed variant. */
  mean_cases_per_variant: number | null;
}

export interface MetricBlock {
  scenario_counts: ScenarioCounts;
  descriptive_assertion_counts: AssertionCounts;
  invariants: InvariantCounts;
  /** Descriptive: matched assertions / evaluated assertions. */
  exact_assertion_match_rate: number | null;
  scenario_bounds: {
    scenario_outcome_mismatch: Bound;
    false_allow: Bound;
    false_deny: Bound;
    bypass: Bound;
  };
}

interface Acc {
  s: ScenarioCounts;
  a: AssertionCounts;
  inv: InvariantCounts;
}

function zero(): Acc {
  return {
    s: {
      cases: 0, adversarial_cases: 0, cases_with_restrictive_expectation: 0, cases_with_permissive_primary: 0, cases_outcome_match: 0,
      cases_exact_match: 0, false_allow_cases: 0, false_deny_cases: 0, bypass_cases: 0, permissive_deviation_outside_denominator: 0,
      decision_effect_mismatch_cases: 0,
    },
    a: {
      assertions_evaluated: 0, assertions_matched: 0, assertions_outcome_matched: 0, restrictive_expectations: 0, permissive_expectations: 0,
      false_allow_mismatches: 0, false_deny_mismatches: 0, reason_mismatches: 0, decision_effect_mismatches: 0, expected_ask: 0,
      ask_to_ask: 0, ask_to_allow: 0, ask_to_deny: 0, allow_to_ask: 0, deny_to_ask: 0,
    },
    inv: { duplicate_executions: 0, unexpected_executions: 0, cross_request_executions: 0, cross_session_executions: 0, unexpected_deliveries: 0, permit_reuses_accepted: 0 },
  };
}

/** Per-case scenario indicators (exported for tests). */
export function scenarioIndicators(c: Case, v: CaseVerdict) {
  const hasRestrictive = c.expected.assertions.some((a) => OUTCOME_POLARITY[a.stage][a.outcome] === "restrictive");
  const primaryPermissive = OUTCOME_POLARITY[c.expected.stage][c.expected.outcome] === "permissive";
  const inv = v.invariants;
  const permissiveDeviation =
    v.mismatches.some((m) => m.kind === "false_allow") ||
    inv.unexpected_execution_count > 0 ||
    inv.unexpected_delivery_count > 0 ||
    inv.permit_reuses_accepted > 0 ||
    inv.cross_request_execution_count > 0 ||
    inv.cross_session_execution_count > 0;
  const primaryFalseDeny = v.checks.some((ch) => ch.primary && !ch.outcome_match && ch.actual !== null && ch.actual.split(",").some((x) => OUTCOME_POLARITY[c.expected.stage][x] === "restrictive"));
  return {
    hasRestrictive,
    primaryPermissive,
    falseAllow: hasRestrictive && permissiveDeviation,
    permissiveOutside: !hasRestrictive && permissiveDeviation,
    falseDeny: primaryPermissive && primaryFalseDeny,
  };
}

function add(acc: Acc, c: Case, v: CaseVerdict): void {
  const ind = scenarioIndicators(c, v);
  const s = acc.s;
  s.cases++;
  if (c.expected.adversarial) s.adversarial_cases++;
  if (ind.hasRestrictive) s.cases_with_restrictive_expectation++;
  if (ind.primaryPermissive) s.cases_with_permissive_primary++;
  if (v.outcome_match) s.cases_outcome_match++;
  if (v.exact_match) s.cases_exact_match++;
  if (ind.falseAllow) s.false_allow_cases++;
  if (ind.permissiveOutside) s.permissive_deviation_outside_denominator++;
  if (ind.falseDeny) s.false_deny_cases++;
  if (v.bypass) s.bypass_cases++;
  if (v.invariants.decision_effect_mismatch_count > 0) s.decision_effect_mismatch_cases++;

  const a = acc.a;
  a.assertions_evaluated += v.checks.length;
  a.assertions_matched += v.checks.filter((x) => x.reason_match).length;
  a.assertions_outcome_matched += v.checks.filter((x) => x.outcome_match).length;
  for (const e of c.expected.assertions) {
    const pol = OUTCOME_POLARITY[e.stage][e.outcome];
    if (pol === "restrictive") a.restrictive_expectations++;
    if (pol === "permissive") a.permissive_expectations++;
    if (e.stage === "request" && e.outcome === "ASK") a.expected_ask++;
  }
  let askMiss = 0;
  for (const m of v.mismatches) {
    if (m.kind === "false_allow") a.false_allow_mismatches++;
    if (m.kind === "false_deny") a.false_deny_mismatches++;
    if (m.kind === "reason_mismatch") a.reason_mismatches++;
    if (m.kind === "decision_effect_mismatch") a.decision_effect_mismatches++;
    if (m.stage === "request" && m.expected === "ASK") {
      askMiss++;
      if (m.actual === "ALLOW") a.ask_to_allow++;
      if (m.actual === "DENY") a.ask_to_deny++;
    }
    if (m.stage === "request" && m.actual === "ASK") {
      if (m.expected === "ALLOW") a.allow_to_ask++;
      if (m.expected === "DENY") a.deny_to_ask++;
    }
  }
  a.ask_to_ask += c.expected.assertions.filter((e) => e.stage === "request" && e.outcome === "ASK").length - askMiss;

  const inv = v.invariants;
  acc.inv.duplicate_executions += inv.duplicate_execution_count;
  acc.inv.unexpected_executions += inv.unexpected_execution_count;
  acc.inv.cross_request_executions += inv.cross_request_execution_count;
  acc.inv.cross_session_executions += inv.cross_session_execution_count;
  acc.inv.unexpected_deliveries += inv.unexpected_delivery_count;
  acc.inv.permit_reuses_accepted += inv.permit_reuses_accepted;
}

function block(acc: Acc): MetricBlock {
  const s = acc.s;
  return {
    scenario_counts: s,
    descriptive_assertion_counts: acc.a,
    invariants: acc.inv,
    exact_assertion_match_rate: acc.a.assertions_evaluated === 0 ? null : round(acc.a.assertions_matched / acc.a.assertions_evaluated),
    scenario_bounds: {
      scenario_outcome_mismatch: bound(s.cases - s.cases_outcome_match, s.cases),
      false_allow: bound(s.false_allow_cases, s.cases_with_restrictive_expectation),
      false_deny: bound(s.false_deny_cases, s.cases_with_permissive_primary),
      bypass: bound(s.bypass_cases, s.adversarial_cases),
    },
  };
}

interface VariantAgg {
  adversarial: boolean;
  cases: number;
  outcomeFailures: number;
  bypasses: number;
  falseDenies: number;
}

function coverage(vars: Map<string, VariantAgg>): VariantCoverage {
  const vs = [...vars.values()];
  const cases = vs.reduce((n, v) => n + v.cases, 0);
  return {
    variants: vs.length,
    adversarial_variants: vs.filter((v) => v.adversarial).length,
    positive_variants: vs.filter((v) => !v.adversarial).length,
    variants_with_outcome_failure: vs.filter((v) => v.outcomeFailures > 0).length,
    adversarial_variants_with_bypass: vs.filter((v) => v.adversarial && v.bypasses > 0).length,
    positive_variants_with_false_deny: vs.filter((v) => !v.adversarial && v.falseDenies > 0).length,
    mean_cases_per_variant: vs.length === 0 ? null : round(cases / vs.length),
  };
}

export interface FamilyMetrics extends MetricBlock {
  variant_coverage: VariantCoverage;
  by_variant: Record<string, MetricBlock>;
}

export interface BoundaryMetrics {
  boundary: "runtime" | "component";
  evaluated_cases: number;
  /** Breadth statistic (unit: designed variant). */
  variant_coverage: VariantCoverage;
  total: MetricBlock;
  family_macro_average: { scenario_outcome_match_rate: number | null; bypass_rate: number | null; families: number };
  by_family: Record<string, FamilyMetrics>;
}

export function computeBoundaryMetrics(boundary: "runtime" | "component", cases: Case[], verdicts: CaseVerdict[]): BoundaryMetrics {
  const vmap = new Map(verdicts.map((v) => [v.case_id, v]));
  const total = zero();
  const fam = new Map<string, { all: Acc; vars: Map<string, Acc>; agg: Map<string, VariantAgg> }>();
  const allAgg = new Map<string, VariantAgg>();
  for (const c of cases) {
    if (c.evaluation_boundary !== boundary) continue;
    const v = vmap.get(c.case_id);
    if (!v) continue; // unevaluated (adapter error) cases are reported as errors, never as passes
    add(total, c, v);
    const f = fam.get(c.family) ?? { all: zero(), vars: new Map(), agg: new Map() };
    add(f.all, c, v);
    const vv = f.vars.get(c.variant) ?? zero();
    add(vv, c, v);
    f.vars.set(c.variant, vv);
    const ind = scenarioIndicators(c, v);
    for (const [m, k] of [[f.agg, c.variant], [allAgg, `${c.family}/${c.variant}`]] as const) {
      const g = m.get(k) ?? { adversarial: c.expected.adversarial, cases: 0, outcomeFailures: 0, bypasses: 0, falseDenies: 0 };
      g.cases++;
      if (!v.outcome_match) g.outcomeFailures++;
      if (v.bypass) g.bypasses++;
      if (ind.falseDeny) g.falseDenies++;
      m.set(k, g);
    }
    fam.set(c.family, f);
  }
  const by_family: Record<string, FamilyMetrics> = {};
  const famRates: number[] = [];
  const famBypass: number[] = [];
  for (const [name, f] of [...fam.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const by_variant: Record<string, MetricBlock> = {};
    for (const [vn, vc] of [...f.vars.entries()].sort(([a], [b]) => a.localeCompare(b))) by_variant[vn] = block(vc);
    const b = block(f.all);
    by_family[name] = { ...b, variant_coverage: coverage(f.agg), by_variant };
    if (f.all.s.cases > 0) famRates.push(f.all.s.cases_outcome_match / f.all.s.cases);
    if (f.all.s.adversarial_cases > 0) famBypass.push(f.all.s.bypass_cases / f.all.s.adversarial_cases);
  }
  const mean = (xs: number[]) => (xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length));
  return {
    boundary,
    evaluated_cases: total.s.cases,
    variant_coverage: coverage(allAgg),
    total: block(total),
    family_macro_average: { scenario_outcome_match_rate: mean(famRates), bypass_rate: mean(famBypass), families: fam.size },
    by_family,
  };
}
