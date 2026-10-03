/**
 * Deterministic JSON for the automotive evidence bundle (evidence.jsonl, manifest.json,
 * report.json and the summary's compact JSON).
 *
 * Accepts the whole JSON data model, because raw_sut_evidence is arbitrary
 * JSON-compatible adapter data (PR C): null, booleans, strings, finite numbers
 * (integers and floats), arrays and plain objects.
 *
 * Rules:
 *  - object keys sorted by UTF-16 code unit order, recursively;
 *  - numbers: finite only, written in ECMAScript's shortest round-trip form
 *    (Number.prototype.toString, which JSON.stringify uses), -0 written as 0; this is
 *    specified by the language, so the bytes do not depend on the platform;
 *  - strings via JSON.stringify;
 *  - rejected, never dropped or coerced: NaN, Infinity, -Infinity, undefined (also as
 *    an object member or array element), bigint, functions, symbols, non-plain objects
 *    (Date, Map, Buffer, class instances, ...) and cycles.
 *
 * For integer-only values the output is byte-identical to src/util/canonical-json.ts.
 */

export class AutomotiveJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomotiveJsonError";
  }
}

function scalar(v: unknown, path: string): string | null {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new AutomotiveJsonError(`non-finite number at ${path}: ${String(v)}`);
      return Object.is(v, -0) ? "0" : JSON.stringify(v);
    case "string":
      return JSON.stringify(v);
    case "object":
      return null;
    default:
      throw new AutomotiveJsonError(`unsupported ${typeof v} at ${path}`);
  }
}

function container(v: object, path: string, seen: Set<object>): { array: unknown[] } | { entries: [string, unknown][] } {
  if (seen.has(v)) throw new AutomotiveJsonError(`cycle at ${path}`);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!(i in v) || v[i] === undefined) throw new AutomotiveJsonError(`undefined array element at ${path}[${i}]`);
    return { array: v };
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new AutomotiveJsonError(`non-plain object at ${path}`);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  for (const k of keys) if (o[k] === undefined) throw new AutomotiveJsonError(`undefined member at ${path}.${k}`);
  if (Object.getOwnPropertySymbols(o).length > 0) throw new AutomotiveJsonError(`symbol-keyed member at ${path}`);
  return { entries: keys.map((k) => [k, o[k]]) };
}

function compact(v: unknown, path: string, seen: Set<object>): string {
  const s = scalar(v, path);
  if (s !== null) return s;
  const c = container(v as object, path, seen);
  seen.add(v as object);
  const out =
    "array" in c
      ? "[" + c.array.map((x, i) => compact(x, `${path}[${i}]`, seen)).join(",") + "]"
      : "{" + c.entries.map(([k, x]) => JSON.stringify(k) + ":" + compact(x, `${path}.${k}`, seen)).join(",") + "}";
  seen.delete(v as object);
  return out;
}

function pretty(v: unknown, path: string, indent: string, seen: Set<object>): string {
  const s = scalar(v, path);
  if (s !== null) return s;
  const c = container(v as object, path, seen);
  seen.add(v as object);
  const inner = indent + "  ";
  let out: string;
  if ("array" in c) out = c.array.length === 0 ? "[]" : `[\n${c.array.map((x, i) => inner + pretty(x, `${path}[${i}]`, inner, seen)).join(",\n")}\n${indent}]`;
  else out = c.entries.length === 0 ? "{}" : `{\n${c.entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, `${path}.${k}`, inner, seen)}`).join(",\n")}\n${indent}}`;
  seen.delete(v as object);
  return out;
}

/** Compact deterministic JSON of one value. */
export function automotiveJson(value: unknown): string {
  return compact(value, "$", new Set());
}

/** Deterministic JSON Lines: one compact value per line, LF, final newline after the last line; empty input = empty string. */
export function automotiveJsonLines(values: readonly unknown[]): string {
  if (values.length === 0) return "";
  return values.map((v, i) => compact(v, `$[${i}]`, new Set())).join("\n") + "\n";
}

/** Two-space, key-sorted pretty JSON with exactly one trailing LF (manifest.json, report.json). */
export function prettyJsonFile(value: unknown): string {
  return pretty(value, "$", "", new Set()) + "\n";
}
