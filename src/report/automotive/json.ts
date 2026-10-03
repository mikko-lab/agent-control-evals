/**
 * Deterministic pretty JSON for manifest.json and report.json: the same value rules as
 * canonical JSON (safe integers only, no undefined, plain objects, keys sorted
 * recursively), two-space indentation, exactly one trailing LF.
 */
import { canonicalJson } from "../../util/canonical-json";

export function prettyJsonFile(value: unknown): string {
  canonicalJson(value); // enforces the canonical value rules; throws on floats, undefined, non-plain objects
  return pretty(value, "") + "\n";
}

function pretty(v: unknown, indent: string): string {
  if (v === null || typeof v !== "object") return canonicalJson(v);
  const inner = indent + "  ";
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => inner + pretty(x, inner)).join(",\n")}\n${indent}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return keys.length === 0 ? "{}" : `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${pretty(o[k], inner)}`).join(",\n")}\n${indent}}`;
}
