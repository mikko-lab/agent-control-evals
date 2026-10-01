/**
 * Deterministic, stratified corpus generator.
 *
 * Same (generator_version, seed, allocation, case count) => byte-identical
 * corpus. Allocation is equal per family (no family can dominate an
 * aggregate), then equal per variant within a family, remainders assigned in
 * declaration order. Each case's content depends only on
 * (seed, family, variant, index-within-variant), never on wall clock,
 * environment, file order or other families' allocation.
 */
import { Rng } from "../util/rng";
import { canonicalJsonLines } from "../util/canonical-json";
import { sha256Hex } from "../util/hash";
import { ALL_FAMILIES, boundaryOfFamily, type Family } from "../spec/families";
import { OUTCOME_POLARITY } from "../spec/outcomes";
import { CASE_SCHEMA_VERSION, GENERATOR_VERSION } from "../version";
import { deriveExpected } from "../oracle/expected";
import { FAMILY_VARIANTS } from "./registry";
import { FAMILY_TARGET_REASONS } from "../spec/family-targets";
import type { Case, Expected } from "./types";

export interface Allocation {
  family: Family;
  variant: string;
  count: number;
}

export function allocate(totalCases: number, families: readonly Family[] = ALL_FAMILIES): Allocation[] {
  if (!Number.isSafeInteger(totalCases) || totalCases < families.length) {
    throw new Error(`case count ${totalCases} must be >= number of families ${families.length}`);
  }
  const out: Allocation[] = [];
  const perFamily = Math.floor(totalCases / families.length);
  let famRemainder = totalCases - perFamily * families.length;
  for (const family of families) {
    const famCount = perFamily + (famRemainder-- > 0 ? 1 : 0);
    const variants = FAMILY_VARIANTS[family];
    const perVariant = Math.floor(famCount / variants.length);
    let varRemainder = famCount - perVariant * variants.length;
    for (const v of variants) {
      out.push({ family, variant: v.name, count: perVariant + (varRemainder-- > 0 ? 1 : 0) });
    }
  }
  return out;
}

export class GeneratorError extends Error {}

export function buildCase(seed: string, family: Family, variantName: string, k: number, caseId: string): Case {
  const variant = FAMILY_VARIANTS[family].find((v) => v.name === variantName);
  if (!variant) throw new GeneratorError(`unknown variant ${family}/${variantName}`);
  const rng = new Rng(seed, `${GENERATOR_VERSION}/${family}/${variantName}/${k}`);
  const built = variant.build(rng);
  const oracle = deriveExpected(built.scenario);
  const p = built.primary;
  const primary = oracle.assertions.find((a) => a.step === p.step && a.stage === p.stage && (p.attempt === undefined || a.attempt === p.attempt));
  if (!primary) throw new GeneratorError(`${caseId} ${family}/${variantName}: oracle produced no assertion for primary ${JSON.stringify(p)}`);
  if (primary.outcome !== variant.intent) {
    throw new GeneratorError(`${caseId} ${family}/${variantName}: oracle outcome ${primary.outcome} != variant intent ${variant.intent}`);
  }
  const polarity = OUTCOME_POLARITY[primary.stage][primary.outcome];
  if (variant.adversarial && polarity === "permissive") {
    throw new GeneratorError(`${caseId}: adversarial variant with permissive expected outcome`);
  }
  if (variant.adversarial) {
    const targets = FAMILY_TARGET_REASONS[family];
    if (!(primary.acceptable_reason_classes ?? []).some((r) => targets.includes(r))) {
      throw new GeneratorError(`${caseId} ${family}/${variantName}: adversarial primary reasons ${JSON.stringify(primary.acceptable_reason_classes)} miss family targets`);
    }
  }
  const invariants = { ...oracle.invariants };
  for (const t of [...(built.cross_request_targets ?? []), ...(built.cross_session_targets ?? [])]) {
    if ((invariants.executions[t] ?? 0) !== 0) throw new GeneratorError(`${caseId}: attack target ${t} expected to execute`);
    if (!(t in invariants.executions)) invariants.executions = { ...invariants.executions, [t]: 0 };
  }
  const expected: Expected = {
    step: primary.step,
    stage: primary.stage,
    outcome: primary.outcome,
    adversarial: variant.adversarial,
    assertions: oracle.assertions,
    invariants: {
      ...invariants,
      ...(built.cross_request_targets ? { cross_request_targets: [...built.cross_request_targets].sort() } : {}),
      ...(built.cross_session_targets ? { cross_session_targets: [...built.cross_session_targets].sort() } : {}),
    } as Expected["invariants"],
  };
  if (primary.attempt !== undefined) expected.attempt = primary.attempt;
  if (primary.acceptable_reason_classes) expected.acceptable_reason_classes = primary.acceptable_reason_classes;
  if (oracle.unordered_steps.length > 0) expected.unordered_steps = oracle.unordered_steps;
  return {
    case_schema_version: CASE_SCHEMA_VERSION,
    case_id: caseId,
    family,
    variant: variantName,
    evaluation_boundary: boundaryOfFamily(family),
    scenario: built.scenario,
    expected,
  };
}

export interface GeneratedCorpus {
  cases: Case[];
  bytes: string;
  sha256: string;
  allocation: Allocation[];
}

export function generateCorpus(seed: string, totalCases: number): GeneratedCorpus {
  const allocation = allocate(totalCases);
  const cases: Case[] = [];
  let n = 0;
  for (const a of allocation) {
    for (let k = 0; k < a.count; k++) {
      n += 1;
      cases.push(buildCase(seed, a.family, a.variant, k, `case-${String(n).padStart(6, "0")}`));
    }
  }
  const bytes = canonicalJsonLines(cases);
  return { cases, bytes, sha256: sha256Hex(Buffer.from(bytes, "utf8")), allocation };
}
