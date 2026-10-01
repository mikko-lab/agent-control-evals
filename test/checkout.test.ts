import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SutCheckoutError, verifyCheckout } from "../src/sut/checkout";
import { loadSutLock, type SutLock } from "../src/sut/lock";

function repo(version = "0.4.0") {
  const d = mkdtempSync(join(tmpdir(), "ace-co-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(d, "package.json"), JSON.stringify({ version }));
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  return { d, head: git("rev-parse", "HEAD") };
}
const lockFor = (sha: string, version = "0.4.0"): SutLock => ({ ...loadSutLock(join(__dirname, "..", "..")), sut_commit: sha, sut_version: version });

test("the committed lock pins the exact v0.1 SUT", () => {
  const l = loadSutLock(join(__dirname, "..", ".."));
  assert.equal(l.sut_commit, "403d31593a0d57187df3f5e1ef3df6127baaefb9");
  assert.equal(l.sut_version, "0.4.0");
  assert.equal(l.follow_upstream, false);
});

test("fail closed: HEAD mismatch", () => {
  const { d } = repo();
  assert.throws(() => verifyCheckout(lockFor("1".repeat(40)), d), SutCheckoutError);
});

test("fail closed: dirty worktree (tracked or untracked)", () => {
  const { d, head } = repo();
  writeFileSync(join(d, "new.txt"), "x");
  assert.throws(() => verifyCheckout(lockFor(head), d), /not clean/);
});

test("fail closed: package version differs from the lock", () => {
  const { d, head } = repo("0.5.0");
  assert.throws(() => verifyCheckout(lockFor(head), d), /version/);
});

test("clean checkout at the pinned SHA verifies", () => {
  const { d, head } = repo();
  assert.equal(verifyCheckout(lockFor(head), d).head, head);
});
