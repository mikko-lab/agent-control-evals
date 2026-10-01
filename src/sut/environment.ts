/**
 * Prepared SUT environments (baseline or mutant): disposable checkout of the
 * pinned SHA, optional patch, npm ci, harness-owned build, adapter command.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SutLock } from "./lock";
import { buildSut, ensureMirror, freshCheckout, npmCi, SutCheckoutError } from "./checkout";
import type { AdapterCommand } from "../eval/client";

export interface SutEnv {
  label: string;
  checkout: string;
  build: string;
  adapter: AdapterCommand;
  patched: boolean;
}

export interface PrepareOptions {
  workDir: string;
  harnessRoot: string;
  sourceOverride?: string;
}

export function adapterCommand(harnessRoot: string, checkout: string, build: string): AdapterCommand {
  return {
    command: process.execPath,
    args: [join(harnessRoot, "dist", "src", "adapter", "acs", "main.js"), "--sut-build", build, "--sut-checkout", checkout],
  };
}

export function prepareBaseline(lock: SutLock, o: PrepareOptions, label = "baseline"): SutEnv {
  const work = resolve(o.workDir);
  const mirror = ensureMirror(lock, work, o.sourceOverride);
  const dir = join(work, "envs", label);
  const info = freshCheckout(lock, mirror, join(dir, "checkout"));
  npmCi(info.dir, join(work, "npm-cache"));
  // npm ci must not dirty the tracked tree (node_modules is ignored by the SUT).
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: info.dir, encoding: "utf8" }).trim();
  if (status !== "") throw new SutCheckoutError(`SUT tracked files changed after npm ci:\n${status}`);
  const build = buildSut(info.dir, join(dir, "build"), o.harnessRoot);
  return { label, checkout: info.dir, build, adapter: adapterCommand(o.harnessRoot, info.dir, build), patched: false };
}

export class PatchError extends Error {}

/** Fresh checkout + one patch. Never reuses a worktree; never chains patches. */
export function prepareMutant(lock: SutLock, o: PrepareOptions, mutationId: string, patchFile: string, targetFile: string): SutEnv {
  const work = resolve(o.workDir);
  const mirror = ensureMirror(lock, work, o.sourceOverride);
  const dir = join(work, "envs", mutationId);
  const info = freshCheckout(lock, mirror, join(dir, "checkout"));
  try {
    execFileSync("git", ["apply", "--check", patchFile], { cwd: info.dir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["apply", patchFile], { cwd: info.dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new PatchError(`patch does not apply: ${(e as { stderr?: Buffer }).stderr?.toString() ?? String(e)}`);
  }
  const changed = execFileSync("git", ["diff", "--name-only"], { cwd: info.dir, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  if (changed.length !== 1 || changed[0] !== targetFile) throw new PatchError(`patch changed ${JSON.stringify(changed)}, expected only ${targetFile}`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: info.dir, encoding: "utf8" }).trim();
  if (head !== lock.sut_commit) throw new PatchError(`mutant HEAD ${head} != baseline ${lock.sut_commit}`);
  npmCi(info.dir, join(work, "npm-cache"));
  const build = buildSut(info.dir, join(dir, "build"), o.harnessRoot);
  return { label: mutationId, checkout: info.dir, build, adapter: adapterCommand(o.harnessRoot, info.dir, build), patched: true };
}

export function disposeEnv(env: SutEnv, workDir: string): void {
  rmSync(join(resolve(workDir), "envs", env.label), { recursive: true, force: true });
}
