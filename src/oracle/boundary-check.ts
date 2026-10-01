/**
 * Static dependency-boundary check for the oracle (and the generator that
 * calls it). Computes the transitive import closure of src/oracle/** and
 * src/corpus/** and fails if it reaches the adapter, the SUT loader, the
 * evaluation runner, the mutation framework, any Node built-in capable of
 * reading SUT state (fs, child_process, net, ...), or any external package.
 *
 * Note: this file lives under src/oracle/ but is itself a build-time checker;
 * it is excluded from the closure it checks (it is not imported by the oracle).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface BoundaryCheckResult {
  ok: boolean;
  roots: string[];
  closure: string[];
  violations: { file: string; import: string; reason: string }[];
  allowed_modules: string[];
}

const ALLOWED_PREFIXES = ["src/oracle/", "src/spec/", "src/corpus/", "src/util/canonical-json.ts", "src/util/rng.ts", "src/util/hash.ts", "src/version.ts"];
const FORBIDDEN_PREFIXES = ["src/adapter/", "src/sut/", "src/eval/", "src/mutation/", "src/report/", "src/cli.ts"];
/** Node built-ins allowed in the closure: hashing only (corpus SHA and the deterministic PRNG). */
const ALLOWED_BUILTINS = new Set(["node:crypto"]);
const SELF = "src/oracle/boundary-check.ts";
/** Files allowed to use node:fs for hashing files on disk; must not be imported by the oracle itself. */
const HASH_FILE_EXCEPTION = "src/util/hash.ts";

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function imports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  if (/\brequire\s*\(\s*[^"'\s)]/.test(src) || /\bimport\s*\(\s*[^"'\s)]/.test(src)) out.push("<dynamic-import>");
  return out;
}

export function checkOracleBoundary(root: string): BoundaryCheckResult {
  const rel = (p: string) => relative(root, p).split("\\").join("/");
  const roots = [...listTs(join(root, "src", "oracle")), ...listTs(join(root, "src", "corpus"))].map(rel).filter((f) => f !== SELF).sort();
  const seen = new Set<string>();
  const violations: BoundaryCheckResult["violations"] = [];
  const queue = [...roots];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(join(root, f), "utf8");
    for (const imp of imports(src)) {
      if (imp === "<dynamic-import>") {
        violations.push({ file: f, import: imp, reason: "dynamic require/import is not allowed in the oracle closure" });
        continue;
      }
      if (!imp.startsWith(".")) {
        if (ALLOWED_BUILTINS.has(imp)) continue;
        if (f === HASH_FILE_EXCEPTION && imp === "node:fs") continue;
        violations.push({ file: f, import: imp, reason: "external package or Node built-in outside the allowlist" });
        continue;
      }
      let target = rel(resolve(dirname(join(root, f)), imp));
      if (!target.endsWith(".ts")) target = `${target}.ts`;
      if (FORBIDDEN_PREFIXES.some((p) => target.startsWith(p))) {
        violations.push({ file: f, import: imp, reason: `oracle closure reaches forbidden module ${target}` });
        continue;
      }
      if (!ALLOWED_PREFIXES.some((p) => target.startsWith(p))) {
        violations.push({ file: f, import: imp, reason: `module ${target} is outside the oracle allowlist` });
        continue;
      }
      queue.push(target);
    }
  }
  // The oracle proper must not touch the filesystem even indirectly.
  for (const f of seen) {
    if (f.startsWith("src/oracle/") && imports(readFileSync(join(root, f), "utf8")).some((i) => i === "node:fs" || i === "fs" || i === "node:fs/promises")) {
      violations.push({ file: f, import: "node:fs", reason: "oracle module reads the filesystem" });
    }
  }
  return { ok: violations.length === 0, roots, closure: [...seen].sort(), violations, allowed_modules: ALLOWED_PREFIXES };
}
