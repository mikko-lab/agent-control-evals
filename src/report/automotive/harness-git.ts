/**
 * Harness repository identity for the automotive CLI. The only automotive module that
 * runs Git; the pure bundle builders receive its result as injected data. Failure to
 * read Git never fails an evaluation: it yields commit "unknown" and worktree_clean
 * false, which the manifest and summary then show.
 */
import { execFileSync } from "node:child_process";
import type { AutomotiveHarnessIdentity } from "./types";

export function readAutomotiveHarnessIdentity(root: string): AutomotiveHarnessIdentity {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return { commit: "unknown", worktree_clean: false };
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { commit, worktree_clean: status.trim() === "" };
  } catch {
    return { commit: "unknown", worktree_clean: false };
  }
}
