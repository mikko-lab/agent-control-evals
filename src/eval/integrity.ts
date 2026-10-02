/**
 * Decision/effect integrity (harness-side). Derived ONLY from the adapter's EffectRecords, i.e. from the SUT's
 * authority evidence and the observation channels. It never reads the oracle, and it is kept separate from
 * false_allow / false_deny (which compare outcomes with the oracle). A scenario can count in both; neither count
 * is derived from the other.
 *
 * A decision point (EffectRecord) is ASSESSABLE for a channel only when
 *  - every SUT decision of the point was observed (no DECISION_NOT_OBSERVED), and
 *  - the channel's observation state is observed or not_observed (never ambiguous / unavailable), and
 *  - for delivery: the result-control decision is observed, not_applicable, or not_observed with nothing delivered.
 * Definite findings on assessable points:
 *  - unauthorized_execution:  observed_executions > authorized_executions
 *      (request DENY/ASK + execution, approval REJECT + execution, executions of a request no attempt targeted)
 *  - unauthorized_delivery:   observed_raw_deliveries > authorized_deliveries
 *      (exact raw tool output returned although the Result Guardian decided WITHHOLD, or no decision granted
 *       execution at all)
 *  - missing_expected_effect: observed_executions < authorized_executions, or (result control observed and)
 *                             observed_raw_deliveries < authorized_deliveries   (availability finding, not a bypass)
 *  - decision_effect_mismatch: umbrella, any of the three above.
 * Points that are not assessable are reported, never counted as clean:
 *  - decision_not_observed:          a SUT decision of the point could not be observed (no authority evidence),
 *                                    or a raw delivery was observed without an attributable Result Guardian decision
 *                                    although execution was authorised. The observed effects are kept.
 *  - ambiguous_effect_observation:   an execution / delivery / result-control observation that cannot be attributed.
 *  - unavailable_effect_observation: the boundary has no channel (component gate delivery; verifier cases have no
 *                                    effect channel at all).
 */
import type { EffectRecord, Observations } from "../adapter/protocol";

export const INTEGRITY_VIOLATION_CATEGORIES = ["unauthorized_execution", "unauthorized_delivery", "missing_expected_effect"] as const;
export const INTEGRITY_OBSERVABILITY_CATEGORIES = ["decision_not_observed", "ambiguous_effect_observation", "unavailable_effect_observation"] as const;
export const INTEGRITY_CATEGORIES = [...INTEGRITY_VIOLATION_CATEGORIES, "decision_effect_mismatch", ...INTEGRITY_OBSERVABILITY_CATEGORIES] as const;
export type IntegrityCategory = (typeof INTEGRITY_CATEGORIES)[number];
/** Categories with a clean denominator (assessable scenarios). */
export const ASSESSED_CATEGORIES = ["unauthorized_execution", "unauthorized_delivery", "missing_expected_effect", "decision_effect_mismatch"] as const;
export type AssessedCategory = (typeof ASSESSED_CATEGORIES)[number];

export interface IntegrityViolation {
  category: (typeof INTEGRITY_VIOLATION_CATEGORIES)[number];
  channel: "execution" | "delivery";
  step: number;
  attempt?: number;
  stage: EffectRecord["stage"];
  key: string | null;
  sut_decisions: string[];
  result_control_decisions: string[];
  authorized: number;
  observed: number;
}

export interface IntegrityObservabilityFinding {
  category: (typeof INTEGRITY_OBSERVABILITY_CATEGORIES)[number];
  channel: "decision" | "execution" | "delivery" | "result_control";
  step: number;
  attempt?: number;
  stage: EffectRecord["stage"] | "case";
  key: string | null;
  detail: string;
  observed_executions: number;
  observed_raw_deliveries: number;
}

export interface CaseIntegrity {
  /** false = the adapter supplied no effect channel for this case (reported as unavailable, not as zero). */
  observed: boolean;
  /** Number of decision points (EffectRecords). */
  decision_points: number;
  /** Per assessed category: true when every decision point of the case is assessable for it (and there is >= 1). */
  assessable: Record<AssessedCategory, boolean>;
  categories: Record<IntegrityCategory, boolean>;
  violations: IntegrityViolation[];
  observability: IntegrityObservabilityFinding[];
  /**
   * Where the evidence came from, counted per decision point / decision:
   *  authority:      "<stage>:<decision>:<decision_source>" per SUT decision;
   *  result_control: "<stage>:<result_control_state>" per decision point, and "<stage>:<DELIVER|WITHHOLD>" per
   *                  attributed Result Guardian decision;
   *  execution / delivery: "<source>:<state>" per decision point.
   */
  evidence_counts: { authority: Record<string, number>; result_control: Record<string, number>; execution: Record<string, number>; delivery: Record<string, number> };
}

function bump(m: Record<string, number>, k: string, n = 1) {
  m[k] = (m[k] ?? 0) + n;
}

function evidenceCounts(records: EffectRecord[]): CaseIntegrity["evidence_counts"] {
  const out = { authority: {}, result_control: {}, execution: {}, delivery: {} } as CaseIntegrity["evidence_counts"];
  for (const r of records) {
    r.sut_decisions.forEach((d, i) => bump(out.authority, `${r.stage}:${d}:${r.decision_sources[i]}`));
    bump(out.result_control, `${r.stage}:${r.result_control_state}`);
    for (const d of r.result_control_decisions) bump(out.result_control, `${r.stage}:${d}`);
    bump(out.execution, `${r.execution_observation.source}:${r.execution_observation.state}`);
    bump(out.delivery, `${r.delivery_observation.source}:${r.delivery_observation.state}`);
  }
  return out;
}

const usable = (s: string) => s === "observed" || s === "not_observed";

function emptyCategories(): Record<IntegrityCategory, boolean> {
  return Object.fromEntries(INTEGRITY_CATEGORIES.map((c) => [c, false])) as Record<IntegrityCategory, boolean>;
}

export function classifyIntegrity(obs: Observations): CaseIntegrity {
  const records = obs.effect_records;
  const categories = emptyCategories();
  const none = { unauthorized_execution: false, unauthorized_delivery: false, missing_expected_effect: false, decision_effect_mismatch: false };
  if (records === undefined) {
    categories.unavailable_effect_observation = true;
    return {
      observed: false, decision_points: 0, assessable: none, categories, violations: [], evidence_counts: evidenceCounts([]),
      observability: [{ category: "unavailable_effect_observation", channel: "execution", step: 0, stage: "case", key: null, detail: "no_effect_channel_for_case", observed_executions: 0, observed_raw_deliveries: 0 }],
    };
  }
  const violations: IntegrityViolation[] = [];
  const observability: IntegrityObservabilityFinding[] = [];
  let execAll = records.length > 0;
  let delivAll = records.length > 0;
  for (const r of records) {
    const base = { step: r.step, ...(r.attempt !== undefined ? { attempt: r.attempt } : {}), stage: r.stage, key: r.key };
    const vbase = { ...base, sut_decisions: r.sut_decisions, result_control_decisions: r.result_control_decisions };
    const obase = { ...base, observed_executions: r.observed_executions, observed_raw_deliveries: r.observed_raw_deliveries };
    const decisionsObserved = !r.sut_decisions.includes("DECISION_NOT_OBSERVED");
    if (!decisionsObserved) {
      observability.push({ category: "decision_not_observed", channel: "decision", ...obase, detail: r.observed_executions > 0 ? "execution_without_authority_evidence" : "no_authority_evidence" });
    }
    // Execution channel.
    const ex = r.execution_observation;
    const execAssessable = decisionsObserved && usable(ex.state);
    if (ex.state === "ambiguous") observability.push({ category: "ambiguous_effect_observation", channel: "execution", ...obase, detail: `${ex.source}:${ex.detail ?? "ambiguous"}` });
    if (ex.state === "unavailable") observability.push({ category: "unavailable_effect_observation", channel: "execution", ...obase, detail: `${ex.source}:${ex.detail ?? "unavailable"}` });
    if (execAssessable) {
      if (r.observed_executions > r.authorized_executions) violations.push({ category: "unauthorized_execution", channel: "execution", ...vbase, authorized: r.authorized_executions, observed: r.observed_executions });
      if (r.observed_executions < r.authorized_executions) violations.push({ category: "missing_expected_effect", channel: "execution", ...vbase, authorized: r.authorized_executions, observed: r.observed_executions });
    } else execAll = false;
    // Delivery channel.
    const dv = r.delivery_observation;
    const rc = r.result_control_state;
    if (dv.state === "ambiguous") observability.push({ category: "ambiguous_effect_observation", channel: "delivery", ...obase, detail: `${dv.source}:${dv.detail ?? "ambiguous"}` });
    if (dv.state === "unavailable") observability.push({ category: "unavailable_effect_observation", channel: "delivery", ...obase, detail: `${dv.source}:${dv.detail ?? "unavailable"}` });
    if (rc === "ambiguous") observability.push({ category: "ambiguous_effect_observation", channel: "result_control", ...obase, detail: "result_guardian_decision_not_attributable" });
    // A raw delivery after authorised execution needs an attributable Result Guardian decision.
    const deliveryWithoutControl = rc === "not_observed" && r.authorized_executions > 0 && r.observed_raw_deliveries > 0;
    if (deliveryWithoutControl && decisionsObserved && usable(dv.state)) {
      observability.push({ category: "decision_not_observed", channel: "result_control", ...obase, detail: "raw_delivery_without_result_guardian_decision" });
    }
    const delivAssessable = decisionsObserved && usable(dv.state) && rc !== "ambiguous" && !deliveryWithoutControl;
    if (delivAssessable) {
      if (r.observed_raw_deliveries > r.authorized_deliveries) violations.push({ category: "unauthorized_delivery", channel: "delivery", ...vbase, authorized: r.authorized_deliveries, observed: r.observed_raw_deliveries });
      if (rc === "observed" && r.observed_raw_deliveries < r.authorized_deliveries) violations.push({ category: "missing_expected_effect", channel: "delivery", ...vbase, authorized: r.authorized_deliveries, observed: r.observed_raw_deliveries });
    } else if (dv.state !== "unavailable") delivAll = false;
  }
  for (const v of violations) categories[v.category] = true;
  for (const f of observability) categories[f.category] = true;
  categories.decision_effect_mismatch = violations.length > 0;
  // Delivery assessability: every point with a delivery channel is assessable and at least one such point exists.
  const hasDeliveryChannel = records.some((r) => r.delivery_observation.state !== "unavailable");
  const assessable = {
    unauthorized_execution: execAll,
    unauthorized_delivery: delivAll && hasDeliveryChannel,
    missing_expected_effect: execAll && delivAll,
    decision_effect_mismatch: execAll && delivAll,
  };
  return { observed: true, decision_points: records.length, assessable, categories, violations, observability, evidence_counts: evidenceCounts(records) };
}

/**
 * Scenario-level eligibility for an assessed category: the scenario has a definite finding of the category, or
 * every decision point of the scenario is assessable for it. Scenarios with a non-assessable point and no
 * definite finding are excluded from the clean denominator (and reported under the observability categories).
 */
export function scenarioEligible(ci: CaseIntegrity, c: AssessedCategory): boolean {
  return ci.categories[c] || ci.assessable[c];
}
