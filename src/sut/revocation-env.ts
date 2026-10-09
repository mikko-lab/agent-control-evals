/**
 * Prepared environments of the revocation track's pinned SUT: a disposable checkout of exactly the locked commit and
 * tree, optionally with one mutant patch, the SUT's own npm ci install, its own typecheck (a mutant that does not
 * typecheck is a technical failure, never a kill) and the harness-owned CommonJS build that the adapter loads.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { buildSut, ensureMirror, freshCheckout, npmCi, runSutVerify, SutCheckoutError } from "./checkout";
import { buildHashes, RevocationLock, verifyRevocationCheckout } from "./revocation-lock";

export interface RevocationEnv {
  label: string;
  checkout: string;
  build: string;
  patched: boolean;
  modules: { path: string; sha256: string }[];
  build_sha256: string;
  baseline_verified: boolean;
  baseline_summary: string | null;
}

export interface RevocationEnvOptions {
  workDir: string;
  harnessRoot: string;
  sourceOverride?: string;
  /** Run the SUT's own `npm run verify` and require the lock's baseline counts. */
  verifyBaseline?: boolean;
  patch?: { file: string; target: string };
}

export class MutantPatchError extends Error {}
export class MutantTypecheckError extends Error {}

export function prepareRevocationEnv(lock: RevocationLock, label: string, o: RevocationEnvOptions): RevocationEnv {
  const work = resolve(o.workDir);
  const mirror = ensureMirror(lock, work, o.sourceOverride);
  const dir = join(work, "envs", label);
  const info = freshCheckout(lock, mirror, join(dir, "checkout"));
  verifyRevocationCheckout(lock, info.dir);
  if (o.patch) {
    try {
      execFileSync("git", ["apply", "--check", o.patch.file], { cwd: info.dir, stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["apply", o.patch.file], { cwd: info.dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      throw new MutantPatchError(`patch ${o.patch.file} does not apply: ${(e as { stderr?: Buffer }).stderr?.toString() ?? String(e)}`);
    }
    const changed = execFileSync("git", ["diff", "--name-only"], { cwd: info.dir, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (changed.length !== 1 || changed[0] !== o.patch.target) throw new MutantPatchError(`patch changed ${JSON.stringify(changed)}, expected only ${o.patch.target}`);
  }
  npmCi(info.dir, join(work, "npm-cache"));
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: info.dir, encoding: "utf8" }).trim();
  if (!o.patch && status !== "") throw new SutCheckoutError(`SUT tracked files changed after npm ci:\n${status}`);
  // The SUT's own typecheck, with its own tsconfig and compiler.
  const tc = spawnSync(process.execPath, [join(info.dir, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", "tsconfig.json"], { cwd: info.dir, encoding: "utf8" });
  if (tc.status !== 0) throw new MutantTypecheckError(`${label}: SUT typecheck failed:\n${tc.stdout}${tc.stderr}`);
  let baseline_verified = false;
  let baseline_summary: string | null = null;
  if (o.verifyBaseline) {
    const v = runSutVerify(info.dir);
    baseline_summary = v.summary;
    const suites = /Test Suites:\s+(\d+) passed, (\d+) total/.exec(v.summary);
    const tests = /Tests:\s+(\d+) passed, (\d+) total/.exec(v.summary);
    baseline_verified = v.ok && !!suites && !!tests && Number(suites[1]) === lock.baseline_at_pin.test_suites && Number(suites[2]) === lock.baseline_at_pin.test_suites && Number(tests[1]) === lock.baseline_at_pin.tests && Number(tests[2]) === lock.baseline_at_pin.tests;
    if (!baseline_verified) throw new SutCheckoutError(`SUT baseline does not reproduce the lock (${lock.baseline_at_pin.test_suites} suites / ${lock.baseline_at_pin.tests} tests):\n${v.summary}`);
  }
  const build = buildSut(info.dir, join(dir, "build"), o.harnessRoot);
  const hashes = buildHashes(build);
  return { label, checkout: info.dir, build, patched: !!o.patch, modules: hashes.modules, build_sha256: hashes.build_sha256, baseline_verified, baseline_summary };
}
