/**
 * Decision/effect integrity (harness-side). Derived ONLY from the adapter's EffectRecords, i.e. from the
 * SUT's own decisions and the harness observation channel. It never reads the oracle, and it is kept
 * separate from false_allow / false_deny (which compare outcomes with the oracle). A scenario can count
 * in both; neither count is derived from the other.
 *
 * Per decision point (EffectRecord):
 *  - unauthorized_execution:   observed_executions > authorized_executions
 *      (request DENY/ASK/UNCLASSIFIED + execution, approval REJECT/UNCLASSIFIED + execution, executions of a
 *       request no attempt targeted, fallback-tool executions, permit REJECT + execution)
 *  - unauthorized_delivery:    delivery_observed && observed_raw_deliveries > authorized_deliveries
 *      (a raw tool output was returned although the SUT's result control said WITHHOLD, or no decision
 *       granted execution/delivery)
 *  - missing_expected_effect:  observed_executions < authorized_executions, or
 *                              delivery_observed && observed_raw_deliveries < authorized_deliveries
 *      (diagnostic / availability finding, not a security bypass)
 *  - decision_effect_mismatch: umbrella, any of the three above.
 */
import type { EffectRecord, Observations } from "../adapter/protocol";

export const INTEGRITY_CATEGORIES = ["unauthorized_execution", "unauthorized_delivery", "missing_expected_effect", "decision_effect_mismatch"] as const;
export type IntegrityCategory = (typeof INTEGRITY_CATEGORIES)[number];

export interface IntegrityViolation {
  category: Exclude<IntegrityCategory, "decision_effect_mismatch">;
  step: number;
  attempt?: number;
  stage: EffectRecord["stage"];
  key: string | null;
  sut_decisions: string[];
  result_control_decisions: string[];
  authorized: number;
  observed: number;
}

export interface CaseIntegrity {
  /** false = the adapter supplied no effect channel for this case (not a zero). */
  observed: boolean;
  /** Number of decision points (EffectRecords) observed. */
  decision_points: number;
  /** Decision points that carry a delivery observation. */
  delivery_points: number;
  categories: Record<IntegrityCategory, boolean>;
  violations: IntegrityViolation[];
}

export function classifyIntegrity(obs: Observations): CaseIntegrity {
  const records = obs.effect_records;
  const categories = { unauthorized_execution: false, unauthorized_delivery: false, missing_expected_effect: false, decision_effect_mismatch: false };
  if (records === undefined) return { observed: false, decision_points: 0, delivery_points: 0, categories, violations: [] };
  const violations: IntegrityViolation[] = [];
  for (const r of records) {
    const base = {
      step: r.step,
      ...(r.attempt !== undefined ? { attempt: r.attempt } : {}),
      stage: r.stage,
      key: r.key,
      sut_decisions: r.sut_decisions,
      result_control_decisions: r.result_control_decisions,
    };
    if (r.observed_executions > r.authorized_executions) {
      violations.push({ category: "unauthorized_execution", ...base, authorized: r.authorized_executions, observed: r.observed_executions });
    }
    if (r.observed_executions < r.authorized_executions) {
      violations.push({ category: "missing_expected_effect", ...base, authorized: r.authorized_executions, observed: r.observed_executions });
    }
    if (r.delivery_observed && r.observed_raw_deliveries > r.authorized_deliveries) {
      violations.push({ category: "unauthorized_delivery", ...base, authorized: r.authorized_deliveries, observed: r.observed_raw_deliveries });
    }
    if (r.delivery_observed && r.observed_raw_deliveries < r.authorized_deliveries) {
      violations.push({ category: "missing_expected_effect", ...base, authorized: r.authorized_deliveries, observed: r.observed_raw_deliveries });
    }
  }
  for (const v of violations) categories[v.category] = true;
  categories.decision_effect_mismatch = violations.length > 0;
  return {
    observed: true,
    decision_points: records.length,
    delivery_points: records.filter((r) => r.delivery_observed).length,
    categories,
    violations,
  };
}
