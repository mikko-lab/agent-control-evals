# P2 evidence availability

## What a repository checkout contains

The [review record](p2-review.md), [portable summary](p2-evidence-summary.json), source, pins, schemas, tests and reproduction commands are proposed for the commit. They summarize observed results; the summary is not a substitute for raw evidence verification.

Generated builds, raw journals, absolute-path manifests, historical local reports and tar.gz bundles are **not** proposed for the commit. `out/` is ignored. Paths under it in command examples are local output destinations, not links to GitHub-hosted artifacts. Historical reports remain untouched in the original worktree, including their original acceptance fields and local links.

## Separately retained packages

Neither package has been uploaded or published. An authorized distribution location (for example an approved PR artifact attachment) is still needed if a future reviewer must inspect the original bytes. Their SHA-256 values identify the exact retained bundles:

| Package | SHA-256 |
|---|---|
| `p2-completion-evidence-2026-11-17.tar.gz` | `752a5c0c3b7114c743d8f27669f0bf404bfeb60e6a3d81b3c05a248cc89155f5` |
| `p2-matrix-gate-evidence-2026-11-17.tar.gz` | `3ccf5a440c09d475d4fd287a526958c4ffa60f9f7f94100347fee752befbdaae` |

The completion bundle preserves the earlier builds, successful/failed live runs and regression logs. The matrix-gate bundle includes the stricter gate evidence, new channel/reference runs, historical matrix inputs needed for replay and the prior inventory. A single package need not contain the entire repository source or installed dependencies: use the proposed source checkout to build the evaluator.

Historical local report names: `p2-evidence-2026-11-17.md`, `p2-completion-2026-11-17.md`, `p2-matrix-gate-2026-11-17.md`. Original inventories are under `docs/external-actions/evidence/` in the retained worktree/packages, not in the proposed commit.

## Verify and relocate recorded evidence without rewriting it

1. Obtain the exact package through a separately authorized channel and verify its whole-file SHA-256 above before extraction into a **new** directory. Preserve the package and original manifests unchanged.
2. Verify every extracted file against its original inventory. Paths in the inventory describe the original layout; resolve them beneath the extraction root. Do not substitute newly calculated hashes for mismatches.
3. Preserve the original `recorded-matrix.json`. Write a **new** binding file with the same format, row names, versions, guards, injections, indices, run IDs, exits and original command records. For each non-null `files.raw`, `files.report`, `files.diagnostic` and `files.rejection` entry, change only its `path` to the extracted file location. Keep `sha256` byte-for-byte unchanged. Rehash the relocated file and require equality before writing the new binding. Missing files or mismatches stop the operation; never repair observations or report fields.
4. Write a separate relocation note naming the original manifest SHA-256, new manifest SHA-256, package SHA-256 and every old→new path mapping. Keep both bindings. Paths in historical command/provenance records remain historical metadata; do not rewrite them to imply a new execution.
5. From a fresh Git checkout with the proposed source, install dependencies from the lockfile and create a new P2 build. Run:

```sh
node scripts/p2-matrix-check.cjs out/p2-build-NEW \
  /path/to/new-recorded-matrix.json out/p2-offline-check-NEW
```

This verifies bound raw/report/diagnostic bytes, original-report replay, determinism and the complete matrix gate. It is **recorded reassessment**, not a new Linux run. The unchanged historical matrix lacking channel diagnostics must fail. Use the documented 20-old + one-new composition for the accepted matrix, not a fabricated diagnostic sidecar.

The legacy import command also requires the original inventory. Because that inventory uses original root-relative paths, run the importer from a layout preserving those paths, or create an explicitly documented, hash-preserving path-only inventory rebinding first. Do not silently rebaseline hashes.

Hash/schema checks do not establish origin. The collector, original binding and execution environment remain trusted. Absolute original paths may identify a machine/user; retain them in the separately controlled evidence rather than copying them into the repository summary.
