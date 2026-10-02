import type { Case } from "../corpus/types";

export type BoundarySelection = "runtime" | "component" | "all";

/** Cases evaluated for a `--boundary` selection (the same selection feeds the baseline and every mutant run). */
export function selectCases(cases: readonly Case[], boundary: BoundarySelection): Case[] {
  return cases.filter((c) => boundary === "all" || c.evaluation_boundary === boundary);
}
