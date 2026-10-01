/**
 * agent-control-evals CLI.
 *
 * Exit codes:
 *   0  run valid, no baseline findings, every executed gate passed
 *   1  run valid, baseline SUT findings present (oracle mismatches on the real SUT)
 *   2  harness invalid (corpus/oracle/adapter/protocol/SUT-SHA/report problem)
 *   3  mutation gate failed (surviving/invalid mutant, reachability problem)
 * When several apply, the highest code wins.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateCorpus } from "./corpus/generate";
import { PROFILES, type ProfileName } from "./corpus/profiles";
import type { Case } from "./corpus/types";
import { checkOracleBoundary } from "./oracle/boundary-check";
import { loadSutLock, REPO_ROOT } from "./sut/lock";
import { prepareBaseline } from "./sut/environment";
import { runSutVerify, verifyCheckout } from "./sut/checkout";
import { checkOracleIntegrity, runCases, type RunOutput } from "./eval/run";
import { canonicalJsonLines } from "./util/canonical-json";
import { sha256Hex } from "./util/hash";
import { loadMutationManifest } from "./mutation/manifest";
import { validateReachability } from "./mutation/reachability";
import { runMutant, type MutantResult } from "./mutation/runner";
import { buildCorpusManifest, harnessGit } from "./report/manifest";
import { buildReport } from "./report/build";
import { validateReport } from "./report/validate";
import { renderSummary } from "./report/summary";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd, ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
    else {
      args[a.slice(2)] = next;
      i++;
    }
  }
  return { cmd: cmd ?? "help", args };
}

const str = (a: Args, k: string, d: string) => (typeof a[k] === "string" ? (a[k] as string) : d);

function profileOf(a: Args): ProfileName {
  const p = str(a, "profile", "smoke");
  if (p !== "smoke" && p !== "full") throw new Error(`unknown profile ${p}`);
  return p;
}

const GOLDEN_SHA = join(REPO_ROOT, "corpus", "smoke.sha256");
const GOLDEN_FILE = join(REPO_ROOT, "corpus", "smoke.jsonl");

function cmdGenerate(a: Args): number {
  const profile = profileOf(a);
  const { seed, cases } = PROFILES[profile];
  const out = resolve(str(a, "out", join("out", profile)));
  mkdirSync(out, { recursive: true });
  const g = generateCorpus(seed, cases);
  writeFileSync(join(out, "corpus.jsonl"), g.bytes, "utf8");
  const manifest = buildCorpusManifest(profile, seed, g, loadSutLock(), harnessGit(REPO_ROOT));
  writeFileSync(join(out, "corpus-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ profile, cases: g.cases.length, corpus_sha256: g.sha256, out }));
  return 0;
}

function goldenCheck(update: boolean) {
  const { seed, cases } = PROFILES.smoke;
  const a = generateCorpus(seed, cases);
  const b = generateCorpus(seed, cases);
  const identical = a.bytes === b.bytes;
  if (update) {
    mkdirSync(join(REPO_ROOT, "corpus"), { recursive: true });
    writeFileSync(GOLDEN_FILE, a.bytes, "utf8");
    writeFileSync(GOLDEN_SHA, `${a.sha256}\n`);
  }
  const expected = existsSync(GOLDEN_SHA) ? readFileSync(GOLDEN_SHA, "utf8").trim() : null;
  const committed = existsSync(GOLDEN_FILE) ? readFileSync(GOLDEN_FILE) : null;
  return {
    determinism: { generated_twice_identical: identical, sha256_first: a.sha256, sha256_second: b.sha256 },
    golden: {
      checked: true,
      expected_sha256: expected,
      matches: expected === null ? false : expected === a.sha256,
      committed_file_identical: committed === null ? false : sha256Hex(committed) === a.sha256,
    },
  };
}

function cmdGolden(a: Args): number {
  const r = goldenCheck(a.update === true);
  console.log(JSON.stringify(r, null, 2));
  return r.determinism.generated_twice_identical && r.golden.matches && r.golden.committed_file_identical ? 0 : 2;
}

function cmdOracleBoundary(): number {
  const r = checkOracleBoundary(REPO_ROOT);
  console.log(JSON.stringify({ ok: r.ok, violations: r.violations, closure: r.closure }, null, 2));
  return r.ok ? 0 : 2;
}

function cmdSutVerify(a: Args): number {
  const lock = loadSutLock();
  const env = prepareBaseline(lock, { workDir: str(a, "work", ".work"), harnessRoot: REPO_ROOT, sourceOverride: typeof a["sut-source"] === "string" ? (a["sut-source"] as string) : undefined }, "sut-verify");
  const info = verifyCheckout(lock, env.checkout);
  const out: Record<string, unknown> = { pinned: lock.sut_commit, head: info.head, clean: info.clean, version: lock.sut_version, build: env.build };
  let code = 0;
  if (a["run-sut-tests"] === true) {
    const v = runSutVerify(env.checkout);
    out.sut_verify = v;
    if (!v.ok) code = 2;
  }
  console.log(JSON.stringify(out, null, 2));
  return code;
}

function cmdReachability(a: Args): number {
  const lock = loadSutLock();
  const env = prepareBaseline(lock, { workDir: str(a, "work", ".work"), harnessRoot: REPO_ROOT }, "reachability");
  const m = loadMutationManifest(REPO_ROOT);
  if (m.baseline_commit !== lock.sut_commit) throw new Error("mutation manifest baseline_commit != sut.lock.json");
  const smoke = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases;
  const rs = m.mutants.map((x) => validateReachability(REPO_ROOT, env.checkout, x, smoke));
  console.log(JSON.stringify(rs, null, 2));
  return rs.every((r) => r.ok) ? 0 : 3;
}

function observationHash(r: RunOutput): string {
  return sha256Hex(canonicalJsonLines(r.results.map((x) => ({ case_id: x.case_id, status: x.status, observations: x.observations }))));
}

async function cmdEvaluate(a: Args): Promise<number> {
  const profile = profileOf(a);
  const boundary = str(a, "boundary", "all");
  if (!["all", "runtime", "component"].includes(boundary)) throw new Error("--boundary must be all|runtime|component");
  const mutations = str(a, "mutations", "none");
  if (!["none", "all", "runtime", "component"].includes(mutations)) throw new Error("--mutations must be none|all|runtime|component");
  const work = str(a, "work", ".work");
  const out = resolve(str(a, "out", join("out", `${profile}-${boundary}`)));
  mkdirSync(out, { recursive: true });
  const lock = loadSutLock();
  const git = harnessGit(REPO_ROOT);
  const log = (m: string) => process.stderr.write(`[ace] ${m}\n`);

  log("oracle dependency boundary check");
  const oracleBoundary = checkOracleBoundary(REPO_ROOT);

  log(`generating ${profile} corpus twice`);
  const { seed, cases: n } = PROFILES[profile];
  const g1 = generateCorpus(seed, n);
  const g2 = generateCorpus(seed, n);
  const golden = profile === "smoke" ? goldenCheck(false).golden : { checked: false, expected_sha256: null, matches: null, committed_file_identical: null };
  writeFileSync(join(out, "corpus.jsonl"), g1.bytes, "utf8");
  const manifest = buildCorpusManifest(profile, seed, g1, lock, git);
  writeFileSync(join(out, "corpus-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const selected: Case[] = g1.cases.filter((c) => boundary === "all" || c.evaluation_boundary === boundary);
  const integrityErrors = checkOracleIntegrity(selected).length;

  log(`preparing pinned SUT ${lock.sut_commit}`);
  const env = prepareBaseline(lock, { workDir: work, harnessRoot: REPO_ROOT, sourceOverride: typeof a["sut-source"] === "string" ? (a["sut-source"] as string) : undefined });
  const co = verifyCheckout(lock, env.checkout);
  const selfVerify = a["run-sut-tests"] === true ? { ran: true, ...runSutVerify(env.checkout) } : { ran: false, ok: null, summary: null };

  log(`running ${selected.length} baseline cases (${boundary})`);
  const baseline = await runCases(selected, env.adapter, lock.sut_commit);
  let obsDet: { checked: boolean; identical: boolean | null; sha256_first: string | null; sha256_second: string | null } = { checked: false, identical: null, sha256_first: null, sha256_second: null };
  if (a["check-observation-determinism"] === true) {
    log("re-running baseline for observation determinism");
    const again = await runCases(selected, env.adapter, lock.sut_commit);
    const h1 = observationHash(baseline);
    const h2 = observationHash(again);
    obsDet = { checked: true, identical: h1 === h2, sha256_first: h1, sha256_second: h2 };
  }

  const mm = loadMutationManifest(REPO_ROOT);
  if (mm.baseline_commit !== lock.sut_commit) throw new Error("mutation manifest baseline_commit != sut.lock.json");
  const smokeCases = profile === "smoke" ? g1.cases : generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases;
  const wanted = (b: string) => (mutations === "all" ? true : mutations === b) && (boundary === "all" || boundary === b);
  const mutants = mm.mutants.filter((x) => (mutations === "none" ? boundary === "all" || boundary === x.evaluation_boundary : wanted(x.evaluation_boundary)));
  const reach = mutants.map((x) => validateReachability(REPO_ROOT, env.checkout, x, smokeCases));
  const mutationResults: MutantResult[] = [];
  const baselineUsable = baseline.harness_errors.length === 0 && baseline.adapter_errors.length === 0;
  if (mutations !== "none") {
    if (!baselineUsable) log("baseline run invalid; mutation analysis skipped");
    else {
      for (const x of mutants) {
        if (!reach.find((r) => r.mutation_id === x.mutation_id)!.ok) {
          mutationResults.push({
            mutation_id: x.mutation_id, family: x.family, evaluation_boundary: x.evaluation_boundary, status: "invalid", invalid_reason: "static reachability validation failed",
            witness_candidates: 0, baseline_valid_witness_candidates: 0, witness_case_ids: [], witness_count: 0, mutant_adapter_errors: 0, mutant_harness_errors: 0,
            outcome_mismatches_by_boundary: { runtime: 0, component: 0 }, boundary_violation: false,
          });
          continue;
        }
        log(`mutant ${x.mutation_id}`);
        mutationResults.push(await runMutant(lock, { workDir: work, harnessRoot: REPO_ROOT, keepEnvs: a["keep-envs"] === true }, x, selected, baseline));
      }
    }
  }

  const report = buildReport({
    profile,
    full_benchmark_executed: profile === "full" && boundary === "all" && baseline.verdicts.length === g1.cases.length,
    manifest,
    cases: selected,
    baseline,
    validity: {
      corpus_determinism: { generated_twice_identical: g1.bytes === g2.bytes, sha256_first: g1.sha256, sha256_second: g2.sha256 },
      golden,
      sut_checkout: { pinned_commit: lock.sut_commit, head: co.head, worktree_clean: co.clean, verified: co.head === lock.sut_commit && co.clean },
      sut_self_verification: selfVerify,
      observation_determinism: obsDet,
    },
    oracle_boundary: oracleBoundary,
    oracle_integrity_errors: integrityErrors,
    reachability: reach,
    mutation: { executed: mutations !== "none" && baselineUsable, corpus_profile: mutations !== "none" ? profile : null, results: mutationResults },
  });
  const valid = validateReport(JSON.parse(JSON.stringify(report)), REPO_ROOT);
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(out, "summary.md"), renderSummary(report));
  log(`report: ${join(out, "report.json")}`);
  process.stdout.write(
    JSON.stringify(
      {
        out,
        report_schema_valid: valid.ok,
        schema_errors: valid.errors.slice(0, 10),
        harness_valid: report.gates.harness_valid,
        problems: report.gates.harness_validity_problems,
        mutation_gate_passed: report.gates.mutation_gate_passed,
        mutation_gate_failures: report.gates.mutation_gate_failures,
        baseline_findings: report.gates.baseline_findings,
        headline: report.headline,
      },
      null,
      2,
    ) + "\n",
  );
  let code = 0;
  if (report.gates.baseline_findings > 0) code = Math.max(code, 1);
  if (report.gates.mutation_gate_passed === false) code = Math.max(code, 3);
  if (!report.gates.harness_valid || !valid.ok) code = Math.max(code, 2);
  return code;
}

function cmdValidateReport(a: Args): number {
  const file = str(a, "file", "");
  if (!file) throw new Error("--file required");
  const r = validateReport(JSON.parse(readFileSync(file, "utf8")), REPO_ROOT);
  console.log(JSON.stringify(r, null, 2));
  return r.ok ? 0 : 2;
}

function cmdSummary(a: Args): number {
  const file = str(a, "file", "");
  if (!file) throw new Error("--file required");
  process.stdout.write(renderSummary(JSON.parse(readFileSync(file, "utf8"))));
  return 0;
}

const HELP = `usage: ace <command> [options]
  generate --profile smoke|full [--out DIR]
  golden [--update]                      smoke corpus determinism + golden SHA + committed bytes
  oracle-boundary                        static oracle dependency-boundary check
  sut-verify [--run-sut-tests]           checkout pinned SUT SHA, verify HEAD/clean/version
  reachability                           static mutation reachability validation
  evaluate --profile smoke|full [--boundary all|runtime|component] [--mutations none|all|runtime|component]
           [--check-observation-determinism] [--run-sut-tests] [--out DIR] [--work DIR]
  validate-report --file report.json
  summary --file report.json`;

async function main(): Promise<number> {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "generate":
      return cmdGenerate(args);
    case "golden":
      return cmdGolden(args);
    case "oracle-boundary":
      return cmdOracleBoundary();
    case "sut-verify":
      return cmdSutVerify(args);
    case "reachability":
      return cmdReachability(args);
    case "evaluate":
      return cmdEvaluate(args);
    case "validate-report":
      return cmdValidateReport(args);
    case "summary":
      return cmdSummary(args);
    default:
      console.log(HELP);
      return cmd === "help" ? 0 : 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`[ace] harness error: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(2);
  },
);
