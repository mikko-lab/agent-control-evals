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

/** Evidence kinds of the tenant and ancestor gates (coverage plan section 7.8). */
export const GATE_KINDS = ["both", "containment_effect", "check_point", "component_check_point"] as const;
/**
 * Evidence kinds of the lifecycle gate (approval-permit lifecycle plan section 8): lifecycle state and availability
 * are their own labels and never containment.
 */
export const LIFECYCLE_GATE_KINDS = [...GATE_KINDS, "lifecycle_effect", "check_and_lifecycle", "availability_effect", "check_and_availability"] as const;
export type GateKind = (typeof LIFECYCLE_GATE_KINDS)[number];

/** One runtime-own mutant gate of the pinned SUT (plan section 7.8): its manifest in the pinned tree and its expected result. */
export interface RuntimeTestGate {
  command: string;
  manifest: string;
  manifest_sha256: string;
  report: string;
  expected_exit: number;
  evidence: Partial<Record<GateKind, string[]>>;
  recorded_gaps: string[];
  /** Lifecycle gate: the report's counts (entries, patches, mechanisms, variants, witness tests). */
  counts?: Record<string, number>;
  /** Lifecycle gate: variants by main entry (not independent mechanisms). */
  variants?: Record<string, string[]>;
  /** Lifecycle gate: entries with labels beyond their claimed kind (reported, never counted). */
  observed_beyond_kind?: string[];
}
export interface RuntimeGateRegressions { command: string; expected_exit: number; cases: Record<string, number> }
export interface RuntimeGateCommand { command: string; expected_exit: number }
export type RuntimeGateName = "tenant" | "ancestor" | "lifecycle";

export interface RevocationLock extends SutLock {
  track: "revocation";
  contract: string;
  sut_tree: string;
  sut_package_lock_sha256: string;
  /** Annotated release tag: an additional identifier that must agree with the commit (never the identity itself). */
  sut_tag?: { name: string; object: string };
  /** Runtime mode the adapter configures (absent: legacy, the a682e44 pin). */
  sut_runtime_mode?: "tenancy" | "legacy";
  /** Lifecycle mode the adapter configures (absent: legacy, the a682e44 and a9deab6 pins; permit: the opt-in approval-permit lifecycle). */
  sut_lifecycle_mode?: "legacy" | "permit";
  /** Maximum chain length of the pinned runtime, leaf included (tenancy mode). */
  max_chain_length?: number;
  runtime_test_gates?: {
    tenant: RuntimeTestGate; ancestor: RuntimeTestGate; regressions: RuntimeGateRegressions;
    /** Permit-mode pins: the lifecycle gate, its own regressions and its witness determinism. */
    lifecycle?: RuntimeTestGate; lifecycle_regressions?: RuntimeGateRegressions; lifecycle_determinism?: RuntimeGateCommand;
  };
  approved_via: string;
  profile: string;
  supplement: string;
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class RevocationLockError extends Error {}

const GATE_COMMAND = /^npm run [a-z:-]+$/;

/** The runtime-own mutant gates a lock pins, by name. */
export function lockGates(lock: RevocationLock): [RuntimeGateName, RuntimeTestGate][] {
  const g = lock.runtime_test_gates;
  if (!g) return [];
  return [["tenant", g.tenant], ["ancestor", g.ancestor], ...(g.lifecycle ? [["lifecycle", g.lifecycle] as [RuntimeGateName, RuntimeTestGate]] : [])];
}

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
  if (lock.sut_tag !== undefined) {
    if (lock.sut_tag.name !== `v${lock.sut_version}`) fail(`sut_tag.name ${String(lock.sut_tag.name)} does not name sut_version ${lock.sut_version}`);
    if (!SHA1.test(lock.sut_tag.object ?? "")) fail("sut_tag.object must be a full 40-hex SHA of the annotated tag object");
    if (lock.sut_tag.object === lock.sut_commit) fail("sut_tag.object must be the annotated tag object, not the commit");
  }
  const mode = lock.sut_runtime_mode ?? "legacy";
  if (mode !== "tenancy" && mode !== "legacy") fail(`sut_runtime_mode ${String(mode)} is neither tenancy nor legacy`);
  if (mode === "tenancy" && (!Number.isSafeInteger(lock.max_chain_length) || (lock.max_chain_length ?? 0) < 1)) fail("tenancy mode needs max_chain_length (a positive integer)");
  if (mode === "legacy" && lock.max_chain_length !== undefined) fail("max_chain_length applies to tenancy mode only");
  const lifecycle = lock.sut_lifecycle_mode ?? "legacy";
  if (lifecycle !== "legacy" && lifecycle !== "permit") fail(`sut_lifecycle_mode ${String(lifecycle)} is neither legacy nor permit`);
  if (lifecycle === "permit" && mode !== "tenancy") fail("permit lifecycle mode is pinned with tenancy mode only");
  if (lock.runtime_test_gates !== undefined) {
    const g = lock.runtime_test_gates;
    if (lifecycle === "permit" && (!g.lifecycle || !g.lifecycle_regressions || !g.lifecycle_determinism)) fail("a permit-mode lock pins the lifecycle gate, its regressions and its determinism check");
    if (lifecycle === "legacy" && (g.lifecycle || g.lifecycle_regressions || g.lifecycle_determinism)) fail("the lifecycle gate applies to permit mode only");
    for (const [name, gate] of [["tenant", g.tenant], ["ancestor", g.ancestor], ...(g.lifecycle ? [["lifecycle", g.lifecycle]] : [])] as [RuntimeGateName, RuntimeTestGate][]) {
      const gateKinds: readonly string[] = name === "lifecycle" ? LIFECYCLE_GATE_KINDS : GATE_KINDS;
      if (!gate || !GATE_COMMAND.test(gate.command ?? "") || typeof gate.manifest !== "string" || typeof gate.report !== "string") fail(`runtime_test_gates.${name}: an npm run command, manifest and report required`);
      if (!SHA256.test(gate.manifest_sha256 ?? "")) fail(`runtime_test_gates.${name}.manifest_sha256 must be a 64-hex SHA-256`);
      if (!Number.isInteger(gate.expected_exit)) fail(`runtime_test_gates.${name}.expected_exit must be an integer`);
      const kinds = Object.keys(gate.evidence ?? {}).sort();
      if (JSON.stringify(kinds) !== JSON.stringify([...gateKinds].sort())) fail(`runtime_test_gates.${name}.evidence must name exactly the kinds ${gateKinds.join(", ")}`);
      const ids = Object.values(gate.evidence).flat() as string[];
      if (!ids.length || ids.some(x => typeof x !== "string") || new Set(ids).size !== ids.length) fail(`runtime_test_gates.${name}.evidence must list each mutant exactly once`);
      if (!Array.isArray(gate.recorded_gaps) || gate.recorded_gaps.some(x => typeof x !== "string")) fail(`runtime_test_gates.${name}.recorded_gaps must be a list`);
      if (name === "lifecycle") {
        if (!gate.counts || Object.values(gate.counts).some(x => !Number.isInteger(x))) fail("runtime_test_gates.lifecycle.counts must pin integer counts");
        if (!gate.variants || Object.entries(gate.variants).some(([k, v]) => !Array.isArray(v) || !v.length || v.some(x => !ids.includes(x)) || !ids.includes(k))) fail("runtime_test_gates.lifecycle.variants must name pinned entries");
        if (!Array.isArray(gate.observed_beyond_kind) || gate.observed_beyond_kind.some(x => !ids.includes(x))) fail("runtime_test_gates.lifecycle.observed_beyond_kind must name pinned entries");
      }
    }
    for (const [name, r] of [["regressions", g.regressions], ...(g.lifecycle_regressions ? [["lifecycle_regressions", g.lifecycle_regressions]] : [])] as [string, RuntimeGateRegressions][]) {
      if (!r || !GATE_COMMAND.test(r.command ?? "") || !Number.isInteger(r.expected_exit) || !Object.keys(r.cases ?? {}).length || Object.values(r.cases).some(x => !Number.isInteger(x))) fail(`runtime_test_gates.${name}: an npm run command, expected_exit and integer case exits required`);
    }
    if (g.lifecycle_determinism && (!GATE_COMMAND.test(g.lifecycle_determinism.command ?? "") || !Number.isInteger(g.lifecycle_determinism.expected_exit))) fail("runtime_test_gates.lifecycle_determinism: an npm run command and expected_exit required");
  }
  return { lock, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** verifyCheckout plus the revocation lock's own checks: tree, package-lock.json bytes and the runtime gate manifests. */
export function verifyRevocationCheckout(lock: RevocationLock, dir: string): void {
  verifyCheckout(lock, dir);
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  if (tree !== lock.sut_tree) throw new SutCheckoutError(`SUT tree ${tree} != pinned ${lock.sut_tree}`);
  const pkgLock = createHash("sha256").update(readFileSync(join(dir, "package-lock.json"))).digest("hex");
  if (pkgLock !== lock.sut_package_lock_sha256) throw new SutCheckoutError(`SUT package-lock.json SHA-256 ${pkgLock} != pinned ${lock.sut_package_lock_sha256}`);
  for (const [, gate] of lockGates(lock)) {
    const got = createHash("sha256").update(readFileSync(join(dir, gate.manifest))).digest("hex");
    if (got !== gate.manifest_sha256) throw new SutCheckoutError(`SUT ${gate.manifest} SHA-256 ${got} != pinned ${gate.manifest_sha256}`);
  }
}

/**
 * The lock's annotated tag must agree with the pinned commit: the tag is fetched from the source into a harness-only
 * ref and must be the pinned tag object, of type tag, pointing at sut_commit. The commit and content hashes stay the
 * SUT identity; a disagreeing tag fails closed instead of being trusted or ignored.
 */
export function verifyRevocationTag(lock: RevocationLock, mirror: string): void {
  if (!lock.sut_tag) return;
  const ref = `refs/ace-verify/tags/${lock.sut_tag.name}`;
  const git = (args: string[]) => execFileSync("git", args, { cwd: mirror, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try { git(["fetch", "--quiet", "--no-tags", "origin", `+refs/tags/${lock.sut_tag.name}:${ref}`]); } catch (e) {
    throw new SutCheckoutError(`SUT tag ${lock.sut_tag.name} is not available from the source: ${(e as { stderr?: Buffer }).stderr?.toString().trim() ?? String(e)}`);
  }
  const object = git(["rev-parse", ref]);
  if (object !== lock.sut_tag.object) throw new SutCheckoutError(`SUT tag ${lock.sut_tag.name} is object ${object}, pinned ${lock.sut_tag.object}`);
  const type = git(["cat-file", "-t", object]);
  if (type !== "tag") throw new SutCheckoutError(`SUT tag ${lock.sut_tag.name} is a ${type}, not an annotated tag`);
  const target = git(["rev-parse", `${object}^{commit}`]);
  if (target !== lock.sut_commit) throw new SutCheckoutError(`SUT tag ${lock.sut_tag.name} points at ${target}, pinned commit ${lock.sut_commit}`);
}

/** SHA-256 of every compiled SUT module under <build>/src, and one hash over the sorted list. */
export function buildHashes(buildDir: string): { modules: { path: string; sha256: string }[]; build_sha256: string } {
  const src = join(resolve(buildDir), "src");
  const walk = (d: string): string[] => readdirSync(d).sort().flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".js") ? [join(d, f)] : []));
  const modules = walk(src).map(p => ({ path: relative(resolve(buildDir), p).split("\\").join("/"), sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }));
  return { modules, build_sha256: createHash("sha256").update(canonicalJson(modules)).digest("hex") };
}
