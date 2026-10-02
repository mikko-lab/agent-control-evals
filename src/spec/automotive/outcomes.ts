/**
 * Normative check verdicts (evaluation spec section 5.1).
 *
 * UNASSESSABLE is not PASS, and HARNESS_ERROR is not a SUT violation.
 * UNVERIFIABLE is an informational record, not a verdict, and is deliberately
 * not part of this vocabulary. There are no severities, grades or scores.
 */
export const AUTOMOTIVE_VERDICTS = ["PASS", "VIOLATION", "UNASSESSABLE", "HARNESS_ERROR"] as const;

export type AutomotiveVerdict = (typeof AUTOMOTIVE_VERDICTS)[number];

export function isAutomotiveVerdict(x: unknown): x is AutomotiveVerdict {
  return typeof x === "string" && (AUTOMOTIVE_VERDICTS as readonly string[]).includes(x);
}
