/**
 * Canonical JSON used for every hashed harness artifact (corpus lines,
 * manifests, patch metadata).
 *
 * Rules:
 *  - object keys sorted by UTF-16 code unit order (Array.prototype.sort default),
 *    recursively;
 *  - no insignificant whitespace;
 *  - strings serialised with JSON.stringify (deterministic escaping);
 *  - numbers MUST be safe integers (floats and non-finite values are rejected so
 *    that no platform-dependent number formatting can reach a hashed artifact);
 *  - `undefined` object members are rejected rather than silently dropped.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(`canonicalJson: non-integer or unsafe number at ${path}: ${value}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v, i) => encode(v, `${path}[${i}]`)).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`canonicalJson: non-plain object at ${path}`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) {
          throw new Error(`canonicalJson: undefined member at ${path}.${k}`);
        }
        parts.push(JSON.stringify(k) + ":" + encode(obj[k], `${path}.${k}`));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value} at ${path}`);
  }
}

/** Canonical JSON Lines: one canonical value per line, LF, final newline after the last line, empty input = empty string. */
export function canonicalJsonLines(values: readonly unknown[]): string {
  if (values.length === 0) return "";
  return values.map((v) => canonicalJson(v)).join("\n") + "\n";
}
