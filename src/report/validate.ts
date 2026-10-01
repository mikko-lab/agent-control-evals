import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function validateReport(report: unknown, root: string): { ok: boolean; errors: string[] } {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "report.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const v = ajv.compile(schema);
  const ok = v(report) as boolean;
  return { ok, errors: (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
}
