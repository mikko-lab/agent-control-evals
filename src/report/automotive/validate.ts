/**
 * Runtime validation of automotive manifests and reports against
 * schemas/automotive/{manifest,report}.schema.json (Ajv, JSON Schema 2020-12).
 *
 * Only the current versions are supported: a document declaring any other
 * manifest_version or report_schema_version fails without being validated against
 * the current schema.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMOTIVE_MANIFEST_VERSION, AUTOMOTIVE_REPORT_SCHEMA_VERSION } from "../../spec/automotive/version";

export interface AutomotiveValidationResult {
  ok: boolean;
  errors: string[];
}

/** Repository root as seen from dist/src/report/automotive. */
export const AUTOMOTIVE_SCHEMA_ROOT = join(__dirname, "..", "..", "..", "..");

const MANIFEST_ID = "https://github.com/mikko-lab/agent-control-evals/schemas/automotive/manifest.schema.json";
const REPORT_ID = "https://github.com/mikko-lab/agent-control-evals/schemas/automotive/report.schema.json";

let compiled: { manifest: ValidateFunction; report: ValidateFunction } | null = null;

export function loadAutomotiveSchema(name: "manifest" | "report", root = AUTOMOTIVE_SCHEMA_ROOT): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "schemas", "automotive", `${name}.schema.json`), "utf8"));
}

function validators() {
  if (compiled) return compiled;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(loadAutomotiveSchema("manifest"), MANIFEST_ID);
  ajv.addSchema(loadAutomotiveSchema("report"), REPORT_ID);
  compiled = { manifest: ajv.getSchema(MANIFEST_ID)!, report: ajv.getSchema(REPORT_ID)! };
  return compiled;
}

function run(v: ValidateFunction, doc: unknown): AutomotiveValidationResult {
  const ok = v(doc) as boolean;
  return { ok, errors: ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

function versionOf(doc: unknown, key: string): unknown {
  return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>)[key] : undefined;
}

export function validateAutomotiveManifest(doc: unknown): AutomotiveValidationResult {
  const v = versionOf(doc, "manifest_version");
  if (v !== AUTOMOTIVE_MANIFEST_VERSION) return { ok: false, errors: [`unsupported manifest_version ${JSON.stringify(v)}; supported: ${AUTOMOTIVE_MANIFEST_VERSION}`] };
  return run(validators().manifest, doc);
}

export function validateAutomotiveReport(doc: unknown): AutomotiveValidationResult {
  const v = versionOf(doc, "report_schema_version");
  if (v !== AUTOMOTIVE_REPORT_SCHEMA_VERSION) return { ok: false, errors: [`unsupported report_schema_version ${JSON.stringify(v)}; supported: ${AUTOMOTIVE_REPORT_SCHEMA_VERSION}`] };
  return run(validators().report, doc);
}
