# Provenance of the committed v0.1 reports

Scope: `reports/v0.1/smoke/` and `reports/v0.1/full/`. Both report `harness_commit = 92452ad3c4438bcbe483a11701c47e90a230fc78`, `harness_worktree_clean = true` and `sut_commit = 403d31593a0d57187df3f5e1ef3df6127baaefb9`. They were committed later, in `012ae2353df526501d1a48ffc9ab2fab315c7c27`. **The storage commit does not change their provenance, and `harness_commit` is left at its historical value.**

## Commits

| Commit | Parent | Content |
|---|---|---|
| `92452ad3c4438bcbe483a11701c47e90a230fc78` | (root) | Harness implementation |
| `012ae2353df526501d1a48ffc9ab2fab315c7c27` | `92452ad…` | Adds `pushurl` hardening in `src/sut/checkout.ts` (+2 lines) and its test, `README.md` (+4), `docs/review-v0.1.md`, and `reports/v0.1/**` |

`git diff --stat 92452ad 012ae23` touches only `README.md`, `docs/review-v0.1.md`, `reports/v0.1/**`, `src/sut/checkout.ts` and `test/checkout.test.ts`.

## How the runs were executed

1. Commit `92452ad`. `git status` was empty (clean).
2. A Node 24 test pass ran `rm -rf dist && npm run build` with Node 24, using the same sources.
3. The smoke run started with `rm -rf dist && npm run build` under Node 22 on the clean tree at `92452ad`, then ran `evaluate --profile smoke --mutations all --check-observation-determinism --run-sut-tests`. `out/smoke-all/report.json` was written at 17:46:08 UTC.
4. The full run reused that `dist/` with no rebuild: `evaluate --profile full --boundary all --mutations all --check-observation-determinism --run-sut-tests`. It started about 17:46:15 (`out/full/corpus-manifest.json` mtime) and ended at 17:54:25 (`out/full/report.json` mtime).
5. **During the full run** the working tree was edited: `src/sut/checkout.ts` (mtime 17:46:39), `test/checkout.test.ts`, `docs/review-v0.1.md` and `README.md`.
6. `dist/` was rebuilt only after the run ended (`dist/src/sut/checkout.js` mtime 17:54:42).

The smoke report was produced entirely before the first edit. The full report overlaps with the edits, so its provenance is the question.

## What the full run read

Read from the harness working tree at run time, from `dist/src/**` (`grep` for `readFileSync` and `git apply`):

| File | Read when | Modified during the run? |
|---|---|---|
| `dist/src/**/*.js` (main process and every adapter process spawned per environment) | main process at start; adapter children at each spawn | No. `dist/` was rebuilt at 17:54:42, after the run ended |
| `sut.lock.json` | start | No (mtime 17:06:46; identical in both commits) |
| `mutations/manifest.json` and `mutations/*.patch` (hashes at start; `git apply` per mutant) | start and per mutant | No (mtimes 17:22–17:24; identical in both commits) |
| `schemas/report.schema.json` | end (report validation) | No (mtime 17:32:37; identical in both commits) |
| `node_modules/` (ajv, ajv-formats) | end | No (`package-lock.json` unchanged) |
| `corpus/smoke.*` | not read in the full profile (golden check is smoke-only) | No |

The edited files are `src/**/*.ts` sources (the run executes compiled JS only), a test, and documentation. None of them is read by `evaluate`.

Outside the harness tree, the run read the SUT mirror and disposable SUT checkouts under `.work/` (read-only clones of `403d315…`, each verified for HEAD, cleanliness and version, recorded in the report) and the npm cache.

## Discriminating evidence that the old code executed

The only executable change between the commits is one line in `ensureMirror` (`src/sut/checkout.ts`) that sets `remote.origin.pushurl` on `.work/sut-mirror.git`. The full run calls `ensureMirror` once for the baseline and once per mutant (17 times). After the run, `git -C .work/sut-mirror.git config --get remote.origin.pushurl` is **unset**, and the mirror's `config` mtime is 17:14:52, before the run. The run therefore executed the `92452ad` version of `checkout.js`.

## Reconstruction

Both commits were compiled from clean `git worktree` checkouts. `diff -rq` of the two outputs shows differences only in `src/sut/checkout.js` and `test/checkout.test.js`. The SHA-256 over all other `dist/src` and `dist/scripts` JS files is identical for both commits: `7ac7c71c786a3cf00477e852dc317e05b07ec1ae3ca2831a511cdf14bc8cf66e`. All measurement code (generator, oracle, adapter, comparator, metrics, mutation runner, report) is therefore byte-identical whichever commit the build came from.

## Assessment

- **Smoke report:** produced from a clean `92452ad` tree before any edit. Provenance `92452ad` is shown.
- **Full report:** the source snapshot is shown to be `92452ad` by four independent lines of evidence: the command order, the file mtimes, the mirror `pushurl` evidence and byte-identical reconstruction. **Residual:** the exact `dist/` artifact that ran was not hashed at run time and no longer exists, so the build artifact is **not attested**. If a reviewer requires artifact attestation, treat the full report as `provenance_unverified` and re-run it from a clean, immutable snapshot with outputs written outside that snapshot. A re-run was deliberately **not** started in this phase.
- Neither report's `harness_commit` has been changed.
