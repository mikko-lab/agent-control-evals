/**
 * The revocation track's own SUT lock (docs/revocation/runtime-adapter-compatibility.md, section 1). It never falls
 * back to sut.lock.json (the ACS v0.1 track), and every check fails closed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { canonicalJson } from "../util/canonical-json";
import { SutCheckoutError, verifyCheckout } from "./checkout";
import type { SutLock } from "./lock";

export const REVOCATION_LOCK_FILE = "sut.revocation.lock.json";

export interface RevocationLock extends SutLock {
  track: "revocation";
  contract: string;
  sut_tree: string;
  sut_package_lock_sha256: string;
  approved_via: string;
  profile: string;
  supplement: string;
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class RevocationLockError extends Error {}

/** Parses and validates the lock bytes; returns the lock and the SHA-256 of its bytes. */
export function loadRevocationLock(path: string, contract: string): { lock: RevocationLock; sha256: string } {
  const bytes = readFileSync(resolve(path));
  const lock = JSON.parse(bytes.toString("utf8")) as RevocationLock;
  const fail = (m: string): never => { throw new RevocationLockError(`${path}: ${m}`); };
  if (lock.track !== "revocation") fail("track must be 'revocation'");
  if (lock.contract !== contract) fail(`contract ${String(lock.contract)} != harness ${contract}`);
  if (!SHA1.test(lock.sut_commit ?? "")) fail("sut_commit must be a full 40-hex SHA");
  if (!SHA1.test(lock.sut_tree ?? "")) fail("sut_tree must be a full 40-hex SHA");
  if (!SHA256.test(lock.sut_package_lock_sha256 ?? "")) fail("sut_package_lock_sha256 must be a 64-hex SHA-256");
  if (lock.follow_upstream !== false) fail("follow_upstream must be false");
  if (typeof lock.sut_version !== "string" || !lock.sut_version) fail("sut_version missing");
  if (typeof lock.sut_repository !== "string" || !lock.sut_repository) fail("sut_repository missing");
  if (typeof lock.profile !== "string" || typeof lock.supplement !== "string") fail("profile and supplement paths required");
  return { lock, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** verifyCheckout plus the revocation lock's own checks: tree and package-lock.json bytes. */
export function verifyRevocationCheckout(lock: RevocationLock, dir: string): void {
  verifyCheckout(lock, dir);
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  if (tree !== lock.sut_tree) throw new SutCheckoutError(`SUT tree ${tree} != pinned ${lock.sut_tree}`);
  const pkgLock = createHash("sha256").update(readFileSync(join(dir, "package-lock.json"))).digest("hex");
  if (pkgLock !== lock.sut_package_lock_sha256) throw new SutCheckoutError(`SUT package-lock.json SHA-256 ${pkgLock} != pinned ${lock.sut_package_lock_sha256}`);
}

/** SHA-256 of every compiled SUT module under <build>/src, and one hash over the sorted list. */
export function buildHashes(buildDir: string): { modules: { path: string; sha256: string }[]; build_sha256: string } {
  const src = join(resolve(buildDir), "src");
  const walk = (d: string): string[] => readdirSync(d).sort().flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".js") ? [join(d, f)] : []));
  const modules = walk(src).map(p => ({ path: relative(resolve(buildDir), p).split("\\").join("/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }));
  return { modules, build_sha256: createHash("sha256").update(canonicalJson(modules)).digest("hex") };
}
