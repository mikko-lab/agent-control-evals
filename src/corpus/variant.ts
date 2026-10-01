import type { Rng } from "../util/rng";
import type { Scenario } from "./types";
import type { Stage } from "../spec/outcomes";

export interface Built {
  scenario: Scenario;
  primary: { step: number; stage: Stage; attempt?: number };
  /** Optional invariant targets: request keys that must never execute (cross-request / cross-session attack targets). */
  cross_request_targets?: string[];
  cross_session_targets?: string[];
}

/**
 * A variant builder. `intent` is the outcome the variant's author intended for
 * the primary assertion. It is NOT used as the expected value: the oracle
 * derives expected values independently, and the generator fails if the two
 * disagree (double-entry check against generator/oracle bugs).
 */
export interface VariantDef {
  name: string;
  adversarial: boolean;
  intent: string;
  build: (rng: Rng) => Built;
}
