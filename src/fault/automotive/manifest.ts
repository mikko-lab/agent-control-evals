/**
 * Fault-set manifest validation (auto-faults-0.1.0). Pure: the caller supplies the parsed
 * document, the corpus entries and the implemented fault ids. Fails closed on any problem.
 */
import { AUTOMOTIVE_VIOLATION_REASONS } from "../../spec/automotive/reason-taxonomy";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../spec/automotive/domains";
import { AUTOMOTIVE_FAULT_SET_VERSION } from "../../spec/automotive/version";
import { PROBE_FIELDS } from "../../corpus/automotive/types";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import { validateAutomotiveFaultSetSchema } from "./validate";
import type { AutomotiveFaultSet } from "./types";

export type FaultSetCheck = { ok: true; faultSet: AutomotiveFaultSet } | { ok: false; errors: string[] };

const has = (list: readonly string[], x: unknown) => typeof x === "string" && list.includes(x);
const blank = (x: unknown) => typeof x !== "string" || x.trim() === "";

/** Semantic checks (also the ones the schema expresses, so the result never depends on the schema alone). */
export function automotiveFaultSetProblems(doc: unknown, entries: readonly AutomotiveCorpusEntry[], implemented: readonly string[]): string[] {
  const p: string[] = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return ["fault set must be an object"];
  const d = doc as Record<string, unknown>;
  if (d.fault_set_version !== AUTOMOTIVE_FAULT_SET_VERSION) return [`unsupported fault_set_version ${JSON.stringify(d.fault_set_version)}; supported: ${AUTOMOTIVE_FAULT_SET_VERSION}`];
  if (!Array.isArray(d.faults) || d.faults.length === 0) return ["faults must be a non-empty array"];
  const variantDomain = new Map(entries.map((e) => [e.case.variant, e.case.domain]));
  const ids = new Set<string>();
  d.faults.forEach((f: Record<string, unknown>, i: number) => {
    const at = `faults[${i}]${typeof f?.fault_id === "string" ? ` (${f.fault_id})` : ""}`;
    if (f === null || typeof f !== "object") return void p.push(`${at}: must be an object`);
    if (blank(f.fault_id)) p.push(`${at}: empty fault_id`);
    else if (ids.has(f.fault_id as string)) p.push(`${at}: duplicate fault_id`);
    else ids.add(f.fault_id as string);
    if (!has(EXECUTABLE_AUTOMOTIVE_DOMAINS, f.domain)) p.push(`${at}: unknown domain ${JSON.stringify(f.domain)}`);
    if (blank(f.description)) p.push(`${at}: empty description`);
    if (blank(f.target_behavior)) p.push(`${at}: empty target_behavior`);
    if (!has(PROBE_FIELDS, f.expected_field)) p.push(`${at}: invalid expected_field ${JSON.stringify(f.expected_field)}`);
    const reasons = Array.isArray(f.expected_reasons) ? f.expected_reasons : [];
    if (reasons.length === 0) p.push(`${at}: expected_reasons must be a non-empty array`);
    for (const r of reasons) if (!has(AUTOMOTIVE_VIOLATION_REASONS, r)) p.push(`${at}: ${JSON.stringify(r)} is not a VIOLATION reason`);
    if (new Set(reasons).size !== reasons.length) p.push(`${at}: duplicate expected reason`);
    const witnesses = Array.isArray(f.witness_variants) ? f.witness_variants : [];
    if (witnesses.length === 0) p.push(`${at}: witness_variants must be a non-empty array`);
    if (new Set(witnesses).size !== witnesses.length) p.push(`${at}: duplicate witness variant`);
    for (const w of witnesses) {
      const dom = variantDomain.get(w as string);
      if (dom === undefined) p.push(`${at}: witness variant ${JSON.stringify(w)} is not in the corpus`);
      else if (dom !== f.domain) p.push(`${at}: witness variant ${w} belongs to ${dom}, not ${String(f.domain)}`);
    }
  });
  const declared = [...ids];
  for (const id of implemented) if (!ids.has(id)) p.push(`implemented fault ${id} is not declared`);
  for (const id of declared) if (!implemented.includes(id)) p.push(`declared fault ${id} is not implemented`);
  return p;
}

/** Schema validation plus semantic checks. */
export function checkAutomotiveFaultSet(doc: unknown, entries: readonly AutomotiveCorpusEntry[], implemented: readonly string[]): FaultSetCheck {
  const semantic = automotiveFaultSetProblems(doc, entries, implemented);
  const schema = validateAutomotiveFaultSetSchema(doc);
  const errors = [...semantic, ...schema.errors.map((e) => `schema: ${e}`)];
  return errors.length === 0 ? { ok: true, faultSet: doc as AutomotiveFaultSet } : { ok: false, errors };
}
