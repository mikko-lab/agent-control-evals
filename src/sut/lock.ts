import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SutLock {
  sut: string;
  sut_repository: string;
  sut_commit: string;
  sut_version: string;
  baseline_at_pin: { test_suites: number; tests: number; ci_node_versions: number[]; verify_command: string };
  follow_upstream: false;
}

export const REPO_ROOT = join(__dirname, "..", "..", "..");

export function loadSutLock(root = REPO_ROOT): SutLock {
  const lock = JSON.parse(readFileSync(join(root, "sut.lock.json"), "utf8")) as SutLock;
  if (!/^[0-9a-f]{40}$/.test(lock.sut_commit)) throw new Error("sut.lock.json: sut_commit must be a full 40-hex SHA");
  if (lock.follow_upstream !== false) throw new Error("sut.lock.json: follow_upstream must be false");
  return lock;
}
