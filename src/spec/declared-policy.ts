/**
 * Declared evaluation specification parameters for the v0.1 SUT profile.
 *
 * These constants are part of the human-authored evaluation specification.
 * They were written down by a human from the pinned SUT's documented demo
 * configuration (ACS v0.1.0 section 10.3 skew window, the demo request policy and
 * ASK approver, the result-policy rule). The oracle does NOT import or execute
 * any SUT code to obtain them; see docs/evaluation-spec.md for provenance and
 * the shared-blind-spot limitation this creates.
 */
export const DECLARED_POLICY = {
  /** Request timestamps outside +/- this window (exclusive bound: |delta| > window) are rejected. */
  request_skew_window_ms: 300_000,
  /** Deterministic request policy by tool name. Tools not listed: DENY. */
  request_policy: {
    read_record: "ALLOW",
    update_record: "ASK",
  } as Record<string, "ALLOW" | "ASK">,
  /** Configured human approver claim for ASK decisions. */
  ask_approver_id: "demo-operator",
  /** Pending ASK lifetime. Approval rejected when elapsed > timeout (elapsed == timeout is still valid). */
  ask_timeout_ms: 300_000,
  /** Approval issued_at may be at most this far after the evaluator's current time. */
  approval_future_skew_ms: 30_000,
  /**
   * Result policy: an output value that is a JSON object whose top-level
   * member "classification" is exactly the string "restricted" is withheld.
   */
  result_withhold_classification: "restricted",
  /** Tools that exist in the evaluation tool universe (others are "unknown"). */
  known_tools: ["read_record", "update_record"],
} as const;

/**
 * Margin kept between any positive (should-execute) scenario's virtual clock
 * advance and the request skew window, because the pinned SUT stamps internal
 * result requests with the wall clock while checking them against the injected
 * evaluation clock. See docs/adapter-protocol-v1.md "Clock model".
 */
export const MAX_POSITIVE_CLOCK_ADVANCE_MS = 240_000;
