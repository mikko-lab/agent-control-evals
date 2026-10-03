/**
 * Runtime validation of the fault-set manifest and the fault-sensitivity report against
 * schemas/automotive/{fault-set,fault-report}.schema.json (Ajv, JSON Schema 2020-12).
 * A document declaring any other version fails without being validated against the current schema.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMOTIVE_FAULT_REPORT_VERSION, AUTOMOTIVE_FAULT_SET_VERSION } from "../../spec/automotive/version";

export interface AutomotiveFaultValidationResult {
  ok: boolean;
  errors: string[];
}

/** Repository root as seen from dist/src/fault/automotive. */
export const AUTOMOTIVE_FAULT_SCHEMA_ROOT = join(__dirname, "..", "..", "..", "..");

export function loadAutomotiveFaultSchema(name: "fault-set" | "fault-report", root = AUTOMOTIVE_FAULT_SCHEMA_ROOT): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "schemas", "automotive", `${name}.schema.json`), "utf8"));
}

let compiled: { faultSet: ValidateFunction; faultReport: ValidateFunction } | null = null;

function validators() {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  compiled = { faultSet: ajv.compile(loadAutomotiveFaultSchema("fault-set")), faultReport: ajv.compile(loadAutomotiveFaultSchema("fault-report")) };
  return compiled;
}

function run(v: ValidateFunction, doc: unknown): AutomotiveFaultValidationResult {
  const ok = v(doc) as boolean;
  return { ok, errors: ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

const field = (doc: unknown, k: string) => (doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>)[k] : undefined);

export function validateAutomotiveFaultSetSchema(doc: unknown): AutomotiveFaultValidationResult {
  const v = field(doc, "fault_set_version");
  if (v !== AUTOMOTIVE_FAULT_SET_VERSION) return { ok: false, errors: [`unsupported fault_set_version ${JSON.stringify(v)}; supported: ${AUTOMOTIVE_FAULT_SET_VERSION}`] };
  return run(validators().faultSet, doc);
}

export function validateAutomotiveFaultReport(doc: unknown): AutomotiveFaultValidationResult {
  const v = field(doc, "fault_report_version");
  if (v !== AUTOMOTIVE_FAULT_REPORT_VERSION) return { ok: false, errors: [`unsupported fault_report_version ${JSON.stringify(v)}; supported: ${AUTOMOTIVE_FAULT_REPORT_VERSION}`] };
  return run(validators().faultReport, doc);
}
