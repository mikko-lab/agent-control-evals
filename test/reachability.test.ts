import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { functionSpan, parsePatch } from "../src/mutation/reachability";
import { loadMutationManifest } from "../src/mutation/manifest";
import { boundaryOfFamily } from "../src/spec/families";

const ROOT = join(__dirname, "..", "..");

test("functionSpan finds methods by brace matching", () => {
  const src = ["class A {", "  foo(x: number) {", "    if (x) {", "      return 1;", "    }", "  }", "  async bar() {", "  }", "}"].join("\n");
  assert.deepEqual(functionSpan(src, "A.foo"), [2, 6]);
  assert.deepEqual(functionSpan(src, "A.bar"), [7, 8]);
  assert.equal(functionSpan(src, "A.baz"), null);
});

test("parsePatch reports touched files and baseline line numbers", () => {
  const p = ["diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -10,4 +10,3 @@", " a", "-b", " c", "+d", " e"].join("\n");
  const r = parsePatch(p);
  assert.deepEqual(r.files, ["src/x.ts"]);
  assert.deepEqual(r.oldLines, [11, 13]);
});

test("mutation manifest: 14 runtime + 3 component mutants, families on their own boundary, hashes verified", () => {
  const m = loadMutationManifest(ROOT);
  assert.equal(m.baseline_commit, "403d31593a0d57187df3f5e1ef3df6127baaefb9");
  assert.equal(m.mutants.filter((x) => x.evaluation_boundary === "runtime").length, 14);
  assert.equal(m.mutants.filter((x) => x.evaluation_boundary === "component").length, 3);
  assert.ok(new Set(m.mutants.map((x) => x.family)).size >= 8);
  for (const x of m.mutants) {
    assert.equal(boundaryOfFamily(x.family), x.evaluation_boundary);
    if (x.evaluation_boundary === "component") assert.ok(x.runtime_unreachability && x.runtime_unreachability.length > 40);
    else assert.ok(/^GuardedExecutor\.(process|resolveApproval|clearSession)/.test(x.reachability_path[0]), x.mutation_id);
  }
  const ids = m.mutants.map((x) => x.mutation_id);
  for (const want of ["M15-verifier-request-binding-bypass", "M16-verifier-session-binding-bypass", "M17-execution-permit-reuse-bypass"]) {
    assert.equal(m.mutants.find((x) => x.mutation_id === want)?.evaluation_boundary, "component");
    assert.ok(ids.includes(want));
  }
});

test("docs/mutation-reachability.md documents every mutant with its path and patch hash", () => {
  const doc = require("node:fs").readFileSync(join(ROOT, "docs", "mutation-reachability.md"), "utf8") as string;
  for (const x of loadMutationManifest(ROOT).mutants) {
    assert.ok(doc.includes(`#### ${x.mutation_id}`), x.mutation_id);
    assert.ok(doc.includes(x.patch_sha256), `${x.mutation_id} hash`);
    for (const hop of x.reachability_path) assert.ok(doc.includes(hop), `${x.mutation_id} hop ${hop}`);
  }
});

test("docs/evaluation-spec.md lists every control of the control matrix", () => {
  const doc = require("node:fs").readFileSync(join(ROOT, "docs", "evaluation-spec.md"), "utf8") as string;
  const { CONTROL_MATRIX } = require("../src/spec/control-matrix");
  for (const c of CONTROL_MATRIX as { control: string }[]) assert.ok(doc.includes(`| ${c.control} |`), c.control);
});
