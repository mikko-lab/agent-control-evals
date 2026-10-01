import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../util/hash";
import { boundaryOfFamily, isFamily, type Family } from "../spec/families";
import { isReasonClass, type ReasonClass } from "../spec/reason-taxonomy";

export interface MutantSpec {
  mutation_id: string;
  family: Family;
  evaluation_boundary: "runtime" | "component";
  description: string;
  target_file: string;
  target_function: string;
  target_invariant: string;
  expected_exposed_invariant: string;
  reachability_path: string[];
  runtime_unreachability?: string;
  witness_families: Family[];
  exposed_reason_classes: ReasonClass[];
  patch_sha256: string;
}

export interface MutationManifest {
  mutation_set_version: string;
  baseline_commit: string;
  mutants: MutantSpec[];
}

export class MutationManifestError extends Error {}

export function patchPath(root: string, id: string): string {
  return join(root, "mutations", `${id}.patch`);
}

export function loadMutationManifest(root: string): MutationManifest {
  const m = JSON.parse(readFileSync(join(root, "mutations", "manifest.json"), "utf8")) as MutationManifest;
  const ids = new Set<string>();
  for (const x of m.mutants) {
    if (ids.has(x.mutation_id)) throw new MutationManifestError(`duplicate mutation_id ${x.mutation_id}`);
    ids.add(x.mutation_id);
    if (!isFamily(x.family)) throw new MutationManifestError(`${x.mutation_id}: unknown family ${x.family}`);
    if (x.evaluation_boundary !== "runtime" && x.evaluation_boundary !== "component") throw new MutationManifestError(`${x.mutation_id}: invalid boundary`);
    if (boundaryOfFamily(x.family) !== x.evaluation_boundary) throw new MutationManifestError(`${x.mutation_id}: family boundary ${boundaryOfFamily(x.family)} != mutant boundary ${x.evaluation_boundary}`);
    for (const f of x.witness_families) {
      if (!isFamily(f) || boundaryOfFamily(f) !== x.evaluation_boundary) throw new MutationManifestError(`${x.mutation_id}: witness family ${f} not on boundary ${x.evaluation_boundary}`);
    }
    for (const r of x.exposed_reason_classes) if (!isReasonClass(r)) throw new MutationManifestError(`${x.mutation_id}: unknown reason ${r}`);
    if (!Array.isArray(x.reachability_path) || x.reachability_path.length < 2) throw new MutationManifestError(`${x.mutation_id}: reachability_path required`);
    const actual = sha256Hex(readFileSync(patchPath(root, x.mutation_id)));
    if (x.patch_sha256 !== actual) throw new MutationManifestError(`${x.mutation_id}: patch_sha256 ${x.patch_sha256} != file ${actual}`);
  }
  return m;
}
