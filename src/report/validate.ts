import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function validateReport(report: unknown, root: string): { ok: boolean; errors: string[] } {
  // Historical reports keep validating against the schema version they were written with.
  const version = (report as { report_schema_version?: unknown } | null)?.report_schema_version;
  const historical: Record<string, string> = { "0.1.0": "report.schema.0.1.0.json", "0.2.0": "report.schema.0.2.0.json", "0.3.0": "report.schema.0.3.0.json" };
  const file = typeof version === "string" && historical[version] ? historical[version] : "report.schema.json";
  const schema = JSON.parse(readFileSync(join(root, "schemas", file), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const v = ajv.compile(schema);
  const ok = v(report) as boolean;
  return { ok, errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
}
