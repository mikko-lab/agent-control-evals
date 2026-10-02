/**
 * Deterministic automotive smoke corpus generator (auto-generator-0.1.0).
 *
 * One case per registered variant, in declaration order, numbered
 * auto-case-000001.. . For each case the oracle runs once and its output is
 * checked against the variant's hand-written intent (double entry); any
 * disagreement throws. Same registry, builders and oracle => byte-identical
 * canonical JSON Lines. No wall clock, environment, randomness, filesystem or
 * network.
 *
 * This module lives outside src/corpus/automotive/ because it joins the input
 * layer with the oracle and the generic canonical-JSON / hash utilities, while
 * the PR A contract test keeps src/corpus/automotive/ importing automotive
 * modules only. It is still inside the oracle dependency-boundary closure.
 */
import { canonicalJsonLines } from "../../util/canonical-json";
import { sha256Hex } from "../../util/hash";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../spec/automotive/domains";
import { AUTOMOTIVE_CORPUS_ENTRY_VERSION, AUTOMOTIVE_ORACLE_VERSION } from "../../spec/automotive/version";
import { deriveAutomotiveExpected } from "../../oracle/automotive/expected";
import type { AutomotiveExpected, ProbeExpectation } from "../../oracle/automotive/types";
import { buildAutomotiveCase } from "../automotive/builders";
import { AUTOMOTIVE_SMOKE_PROFILE } from "../automotive/profiles";
import { AUTOMOTIVE_VARIANTS } from "../automotive/registry";
import type { AutomotiveVariantDef, ProbeIntent } from "../automotive/variant";
import type { AutomotiveCorpusEntry } from "./corpus-entry";

export class AutomotiveGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveGeneratorError";
  }
}

export interface GeneratedAutomotiveCorpus {
  profile: typeof AUTOMOTIVE_SMOKE_PROFILE.id;
  entries: AutomotiveCorpusEntry[];
  bytes: string;
  sha256: string;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function checkProbe(where: string, intent: ProbeIntent, e: ProbeExpectation, currency: string): string[] {
  const p: string[] = [];
  if (intent.field !== e.field) return [`${where}: oracle field ${e.field} != intent field ${intent.field}`];
  if (e.cross_listing_candidates.length < intent.min_cross_listing_candidates) {
    p.push(`${where}: ${e.cross_listing_candidates.length} cross-listing candidates < intent minimum ${intent.min_cross_listing_candidates}`);
  }
  if (e.planted_conflict_candidates.length < intent.min_planted_conflicts) {
    p.push(`${where}: ${e.planted_conflict_candidates.length} planted conflicts < intent minimum ${intent.min_planted_conflicts}`);
  }
  if (intent.field === "price") {
    if (e.kind !== "price") return [...p, `${where}: oracle produced a ${e.kind} expectation for a price intent`];
    const accepted = e.accepted_presentations.map((a) => ({ basis: a.basis, amount_minor: a.amount_minor }));
    if (!sameJson(accepted, intent.accepted)) p.push(`${where}: oracle accepted ${JSON.stringify(accepted)} != intent ${JSON.stringify(intent.accepted)}`);
    if (e.accepted_presentations.some((a) => a.currency !== currency)) p.push(`${where}: accepted presentation in a currency other than ${currency}`);
    const superseded = e.superseded_listing_prices.map((s) => s.amount_minor);
    if (!sameJson(superseded, intent.superseded)) p.push(`${where}: oracle superseded ${JSON.stringify(superseded)} != intent ${JSON.stringify(intent.superseded)}`);
  } else {
    if (e.kind !== "vehicle_fact") return [...p, `${where}: oracle produced a ${e.kind} expectation for a fact intent`];
    if (e.expected.value !== intent.expected) p.push(`${where}: oracle expected ${JSON.stringify(e.expected.value)} != intent ${JSON.stringify(intent.expected)}`);
  }
  return p;
}

/** Problems between a variant's intent and the oracle output (empty = they agree). */
export function variantIntentProblems(def: AutomotiveVariantDef, expected: AutomotiveExpected, currency: string): string[] {
  const where = `${def.domain}/${def.name}`;
  const intents = new Map(def.intent.probes.map((x) => [x.probe_id, x]));
  if (intents.size !== def.intent.probes.length) return [`${where}: duplicate probe_id in intent`];
  const got = expected.probe_expectations.map((e) => e.probe_id);
  if (!sameJson([...got].sort(), [...intents.keys()].sort())) return [`${where}: oracle probes ${JSON.stringify(got)} != intent probes ${JSON.stringify([...intents.keys()])}`];
  if (got.length === 0) return [`${where}: a variant must declare at least one probe`];
  return expected.probe_expectations.flatMap((e) => checkProbe(`${where}/${e.probe_id}`, intents.get(e.probe_id)!, e, currency));
}

/** Builds one corpus entry: case, oracle output (once), double-entry check. */
export function buildAutomotiveCorpusEntry(def: AutomotiveVariantDef, n: number): AutomotiveCorpusEntry {
  const { scenario, annotations } = def.build();
  const c = buildAutomotiveCase({ n, domain: def.domain, variant: def.name, scenario, annotations });
  const expected = deriveAutomotiveExpected(c);
  if (expected.case_id !== c.case_id) throw new AutomotiveGeneratorError(`${c.case_id}: oracle case_id ${expected.case_id} differs`);
  if (expected.domain !== c.domain) throw new AutomotiveGeneratorError(`${c.case_id}: oracle domain ${expected.domain} differs`);
  if (expected.oracle_version !== AUTOMOTIVE_ORACLE_VERSION) throw new AutomotiveGeneratorError(`${c.case_id}: oracle_version ${String(expected.oracle_version)}`);
  const problems = variantIntentProblems(def, expected, c.scenario.currency);
  if (problems.length > 0) throw new AutomotiveGeneratorError(`${c.case_id}: oracle output contradicts variant intent: ${problems.join("; ")}`);
  return { corpus_entry_version: AUTOMOTIVE_CORPUS_ENTRY_VERSION, case: c, expected };
}

export function generateAutomotiveSmokeCorpus(variants: readonly AutomotiveVariantDef[] = AUTOMOTIVE_VARIANTS): GeneratedAutomotiveCorpus {
  const pairs = new Set<string>();
  for (const v of variants) {
    const k = `${v.domain}/${v.name}`;
    if (pairs.has(k)) throw new AutomotiveGeneratorError(`duplicate variant ${k}`);
    pairs.add(k);
  }
  for (const d of EXECUTABLE_AUTOMOTIVE_DOMAINS) {
    const count = variants.filter((v) => v.domain === d).length;
    if (count !== AUTOMOTIVE_SMOKE_PROFILE.variants_per_domain) throw new AutomotiveGeneratorError(`domain ${d} has ${count} variants, profile requires ${AUTOMOTIVE_SMOKE_PROFILE.variants_per_domain}`);
  }
  if (variants.length !== AUTOMOTIVE_SMOKE_PROFILE.cases) throw new AutomotiveGeneratorError(`${variants.length} variants, profile requires ${AUTOMOTIVE_SMOKE_PROFILE.cases}`);
  const entries = variants.map((v, i) => buildAutomotiveCorpusEntry(v, i + 1));
  const ids = new Set(entries.map((e) => e.case.case_id));
  if (ids.size !== entries.length) throw new AutomotiveGeneratorError("duplicate case_id");
  const bytes = canonicalJsonLines(entries);
  return { profile: AUTOMOTIVE_SMOKE_PROFILE.id, entries, bytes, sha256: sha256Hex(Buffer.from(bytes, "utf8")) };
}
