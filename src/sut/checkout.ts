/**
 * Disposable, read-only SUT checkouts.
 *
 * The SUT repository is only ever cloned/fetched. Nothing is pushed, no
 * remote is modified, and every checkout lives under the harness work
 * directory. Fail closed: if the pinned SHA cannot be checked out, HEAD does
 * not match, or the worktree is not clean, the benchmark does not run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SutLock } from "./lock";

export class SutCheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SutCheckoutError";
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Local bare mirror used as the fetch source for disposable checkouts. */
export function ensureMirror(lock: SutLock, workDir: string, sourceOverride?: string): string {
  const mirror = resolve(workDir, "sut-mirror.git");
  const source = sourceOverride ?? lock.sut_repository;
  if (!existsSync(mirror)) {
    mkdirSync(workDir, { recursive: true });
    execFileSync("git", ["clone", "--bare", "--quiet", source, mirror], { stdio: ["ignore", "pipe", "pipe"] });
  }
  try {
    git(mirror, ["cat-file", "-e", `${lock.sut_commit}^{commit}`]);
  } catch {
    try {
      git(mirror, ["fetch", "--quiet", "origin", lock.sut_commit]);
      git(mirror, ["cat-file", "-e", `${lock.sut_commit}^{commit}`]);
    } catch {
      throw new SutCheckoutError(`pinned SUT commit ${lock.sut_commit} is not available from ${source}`);
    }
  }
  return mirror;
}

export interface CheckoutInfo {
  dir: string;
  head: string;
  clean: boolean;
}

/** Fresh detached checkout of exactly the pinned SHA. Never reused across mutants. */
export function freshCheckout(lock: SutLock, mirror: string, dirIn: string): CheckoutInfo {
  const dir = resolve(dirIn);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--no-checkout", "--no-hardlinks", mirror, dir], { stdio: ["ignore", "pipe", "pipe"] });
  // Remove the remote so nothing can ever be pushed from a disposable checkout.
  git(dir, ["remote", "remove", "origin"]);
  git(dir, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", lock.sut_commit]);
  return verifyCheckout(lock, dir);
}

export function verifyCheckout(lock: SutLock, dirIn: string): CheckoutInfo {
  const dir = resolve(dirIn);
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (head !== lock.sut_commit) {
    throw new SutCheckoutError(`SUT HEAD ${head} != pinned ${lock.sut_commit}`);
  }
  const status = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") throw new SutCheckoutError(`SUT worktree not clean:\n${status}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  if (pkg.version !== lock.sut_version) throw new SutCheckoutError(`SUT package version ${pkg.version} != pinned ${lock.sut_version}`);
  return { dir, head, clean: true };
}

/** `npm ci` inside the disposable checkout (node_modules is gitignored by the SUT). */
export function npmCi(dirIn: string, cacheDir?: string): void {
  const dir = resolve(dirIn);
  const args = ["ci", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"];
  if (cacheDir) args.push(`--cache=${cacheDir}`, "--prefer-offline");
  execFileSync("npm", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Compile the SUT's src/ to CommonJS outside the SUT worktree using a
 * harness-owned tsconfig. The SUT tree itself is not modified.
 * Returns the build directory; SUT modules live under <build>/src.
 */
export function buildSut(dirIn: string, buildDirIn: string, harnessRoot: string): string {
  const dir = resolve(dirIn);
  const buildDir = resolve(buildDirIn);
  if (existsSync(buildDir)) rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const tsconfigPath = join(buildDir, "tsconfig.sut-build.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "commonjs",
          esModuleInterop: true,
          resolveJsonModule: true,
          strict: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [join(dir, "node_modules", "@types")],
          rootDir: dir,
          outDir: buildDir,
          noEmitOnError: true,
        },
        files: [join(dir, "src", "guarded-executor.ts"), join(dir, "src", "tools.ts")],
        include: [join(dir, "src", "**", "*.ts")],
      },
      null,
      2,
    ),
  );
  const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
  try {
    execFileSync(process.execPath, [tsc, "-p", tsconfigPath], { cwd: harnessRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    throw new SutCheckoutError(`SUT build failed:\n${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`);
  }
  if (!existsSync(join(buildDir, "src", "guarded-executor.js"))) throw new SutCheckoutError("SUT build produced no guarded-executor.js");
  // Resolve the SUT's runtime dependencies (ajv, json-canonicalize, ...) from its own npm ci install.
  symlinkSync(join(dir, "node_modules"), join(buildDir, "node_modules"), "dir");
  return buildDir;
}

/** Runs the SUT's own `npm run verify` (typecheck + Jest) and returns the Jest summary lines. */
export function runSutVerify(dir: string): { ok: boolean; summary: string } {
  // Jest writes its summary to stderr; capture both streams.
  const r = spawnSync("npm", ["run", "verify", "--silent"], { cwd: resolve(dir), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const summary = text.split("\n").filter((l) => /^(Test Suites|Tests|Snapshots):/.test(l.trim())).map((l) => l.trim()).join("\n");
  return { ok: r.status === 0, summary };
}
