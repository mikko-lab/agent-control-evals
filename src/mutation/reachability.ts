/**
 * Static mutation-reachability validation (dynamic evidence comes from the
 * mutation run itself). For every mutant:
 *  - the patch touches exactly its declared target_file;
 *  - every changed line lies inside the declared target_function at the
 *    pinned baseline;
 *  - runtime mutants: the path starts at a public GuardedExecutor runtime API
 *    that exists at the baseline;
 *  - component mutants: the path starts at the component method and a written
 *    runtime_unreachability argument is present;
 *  - the smoke corpus contains enough witness candidates on the same boundary.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Case } from "../corpus/types";
import type { MutantSpec } from "./manifest";
import { patchPath } from "./manifest";

export const PUBLIC_RUNTIME_API = ["GuardedExecutor.process", "GuardedExecutor.resolveApproval", "GuardedExecutor.clearSession"];
export const MIN_SMOKE_WITNESS_CANDIDATES = 3;

export interface ReachabilityResult {
  mutation_id: string;
  evaluation_boundary: "runtime" | "component";
  ok: boolean;
  problems: string[];
  target_file: string;
  target_function: string;
  target_function_lines: [number, number] | null;
  changed_baseline_lines: number[];
  reachability_path: string[];
  runtime_unreachability: string | null;
  smoke_witness_candidates: number;
}

/** Locate `name(` as a method declaration and return its [start, end] 1-based line span by brace matching. */
export function functionSpan(source: string, qualified: string): [number, number] | null {
  const name = qualified.split(".").pop()!;
  const lines = source.split("\n");
  const re = new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${name}\\s*(?:<[^>]*>)?\\(`);
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j].replace(/\/\/.*$/, "")) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth === 0) return [i + 1, j + 1];
    }
  }
  return null;
}

/** Baseline (old-side) line numbers removed or adjacent to insertions, per unified diff. */
export function parsePatch(patch: string): { files: string[]; oldLines: number[] } {
  const files = new Set<string>();
  const oldLines: number[] = [];
  let oldLine = 0;
  for (const l of patch.split("\n")) {
    const f = /^\+\+\+ b\/(.+)$/.exec(l) ?? /^--- a\/(.+)$/.exec(l);
    if (f) {
      files.add(f[1]);
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (h) {
      oldLine = Number(h[1]);
      continue;
    }
    if (oldLine === 0) continue;
    if (l.startsWith("-")) {
      oldLines.push(oldLine);
      oldLine++;
    } else if (l.startsWith("+")) {
      oldLines.push(oldLine); // insertion point
    } else if (l.startsWith(" ")) {
      oldLine++;
    }
  }
  return { files: [...files], oldLines };
}

export function validateReachability(root: string, sutDir: string, m: MutantSpec, smoke: Case[]): ReachabilityResult {
  const problems: string[] = [];
  const patch = readFileSync(patchPath(root, m.mutation_id), "utf8");
  const { files, oldLines } = parsePatch(patch);
  if (files.length !== 1 || files[0] !== m.target_file) problems.push(`patch touches ${JSON.stringify(files)}, expected only ${m.target_file}`);
  const source = readFileSync(join(sutDir, m.target_file), "utf8");
  const span = functionSpan(source, m.target_function);
  if (!span) problems.push(`target_function ${m.target_function} not found in ${m.target_file} at baseline`);
  else if (oldLines.some((n) => n < span[0] || n > span[1])) problems.push(`patch changes lines outside ${m.target_function} [${span[0]}-${span[1]}]: ${oldLines.join(",")}`);
  const ge = readFileSync(join(sutDir, "src", "guarded-executor.ts"), "utf8");
  if (m.evaluation_boundary === "runtime") {
    const entry = m.reachability_path[0];
    const api = PUBLIC_RUNTIME_API.find((a) => entry.startsWith(a));
    if (!api) problems.push(`runtime mutant path must start at a public runtime API (${PUBLIC_RUNTIME_API.join(", ")}), got "${entry}"`);
    else if (!functionSpan(ge, api)) problems.push(`public runtime API ${api} not found at baseline`);
    if (m.runtime_unreachability) problems.push("runtime mutant must not declare runtime_unreachability");
  } else {
    if (!m.runtime_unreachability || m.runtime_unreachability.length < 40) problems.push("component mutant requires a runtime_unreachability argument");
    if (!m.reachability_path[0].startsWith(m.target_function.split(".")[0])) problems.push("component mutant path must start at the target component");
  }
  const candidates = smoke.filter(
    (c) =>
      m.witness_families.includes(c.family) &&
      c.evaluation_boundary === m.evaluation_boundary &&
      c.expected.adversarial &&
      (c.expected.acceptable_reason_classes ?? []).some((r) => m.exposed_reason_classes.includes(r)),
  ).length;
  if (candidates < MIN_SMOKE_WITNESS_CANDIDATES) problems.push(`only ${candidates} smoke witness candidates (< ${MIN_SMOKE_WITNESS_CANDIDATES})`);
  return {
    mutation_id: m.mutation_id,
    evaluation_boundary: m.evaluation_boundary,
    ok: problems.length === 0,
    problems,
    target_file: m.target_file,
    target_function: m.target_function,
    target_function_lines: span,
    changed_baseline_lines: [...new Set(oldLines)].sort((a, b) => a - b),
    reachability_path: m.reachability_path,
    runtime_unreachability: m.runtime_unreachability ?? null,
    smoke_witness_candidates: candidates,
  };
}
