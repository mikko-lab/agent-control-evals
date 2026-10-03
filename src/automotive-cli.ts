/**
 * Automotive Agent Assurance CLI (auto-0.1.0). Separate from the ACS CLI (src/cli.ts).
 *
 *   evaluate --profile smoke (--reference-agent | --adapter-command <exe> [--adapter-arg <a>]...) --out <dir> [--timeout-ms <n>]
 *   validate-report --file <report.json>
 *   validate-manifest --file <manifest.json>
 *   summary --file <report.json>
 *   faults --profile smoke --out <dir>
 *   validate-fault-report --file <fault-sensitivity.json>
 *
 * evaluate exit codes:
 *   0  harness and report valid, no VIOLATION scenario (UNASSESSABLE may be present: see all_required_assessed)
 *   1  harness and report valid, one or more VIOLATION scenarios
 *   2  harness or report invalid: golden mismatch, run_valid false, HARNESS_ERROR, build inconsistency,
 *      schema validation failure, bad arguments
 *
 * faults exit codes (exit 1 is never used, it stays the evaluate SUT-VIOLATION code):
 *   0  baseline valid and every declared synthetic fault killed
 *   2  harness or self-test invalid: golden mismatch, invalid fault set, baseline failure, build or schema failure
 *   3  fault gate failed: one or more declared faults survived or were invalid
 *
 * stdout carries one JSON object (or, for summary, the Markdown). Adapters are started without a shell,
 * with command and arguments kept separate.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateAutomotiveSmokeCorpus } from "./corpus/automotive-generation/generate";
import type { AutomotiveCorpusEntry } from "./corpus/automotive-generation/corpus-entry";
import type { AutomotiveAdapterCommand } from "./adapter/automotive/jsonl-client";
import { runAutomotiveCorpus } from "./eval/automotive/run";
import { sha256Hex } from "./util/hash";
import { buildAutomotiveBundle } from "./report/automotive/build";
import { readAutomotiveHarnessIdentity } from "./report/automotive/harness-git";
import { prettyJsonFile } from "./report/automotive/json";
import { renderAutomotiveSummary } from "./report/automotive/summary";
import { AutomotiveReportBuildError, type AutomotiveHarnessIdentity, type AutomotiveReport } from "./report/automotive/types";
import { validateAutomotiveManifest, validateAutomotiveReport } from "./report/automotive/validate";
import { AUTOMOTIVE_FAULT_OUTPUT_DIRS, AUTOMOTIVE_FAULT_OUTPUT_FILES, runAutomotiveFaultGate, type AutomotiveFaultGateOptions } from "./fault/automotive/runner";
import { validateAutomotiveFaultReport } from "./fault/automotive/validate";

export const AUTOMOTIVE_REPO_ROOT = join(__dirname, "..", "..");
export const AUTOMOTIVE_BUNDLE_FILES = ["corpus.jsonl", "evidence.jsonl", "manifest.json", "report.json", "summary.md"] as const;

export interface CliResult {
  exitCode: 0 | 1 | 2 | 3;
  /** One JSON value, or the summary Markdown for `summary`. */
  stdout: unknown;
}

// ---------------------------------------------------------------- golden precondition

export type GoldenCheck = { ok: true; entries: AutomotiveCorpusEntry[]; bytes: string; sha256: string } | { ok: false; error: string };

/** Generates the smoke corpus twice and requires both to equal the committed golden bytes and SHA file. */
export function checkAutomotiveGolden(root: string): GoldenCheck {
  const a = generateAutomotiveSmokeCorpus();
  const b = generateAutomotiveSmokeCorpus();
  if (a.bytes !== b.bytes || a.sha256 !== b.sha256) return { ok: false, error: "automotive smoke corpus generation is not deterministic" };
  let committed: string;
  let committedSha: string;
  try {
    committed = readFileSync(join(root, "corpus", "automotive", "smoke.jsonl"), "utf8");
    committedSha = readFileSync(join(root, "corpus", "automotive", "smoke.sha256"), "utf8").trim();
  } catch (e) {
    return { ok: false, error: `committed automotive golden corpus could not be read: ${(e as Error).message}` };
  }
  if (a.bytes !== committed) return { ok: false, error: "generated automotive smoke corpus differs from the committed golden corpus/automotive/smoke.jsonl" };
  if (a.sha256 !== committedSha || sha256Hex(Buffer.from(committed, "utf8")) !== committedSha) return { ok: false, error: `automotive golden SHA mismatch: generated ${a.sha256}, committed ${committedSha}` };
  return { ok: true, entries: a.entries, bytes: a.bytes, sha256: a.sha256 };
}

// ---------------------------------------------------------------- evaluate

export interface EvaluateOptions {
  root: string;
  out: string;
  adapter: AutomotiveAdapterCommand;
  timeoutMs?: number;
  /** Injected harness identity; defaults to reading Git in `root`. */
  harnessIdentity?: AutomotiveHarnessIdentity;
}

const harnessFailure = (error: string): CliResult => ({ exitCode: 2, stdout: { ok: false, error } });

export async function evaluateAutomotive(o: EvaluateOptions): Promise<CliResult> {
  // Never leave a stale bundle behind, whatever happens next (removing is not writing a report).
  for (const f of AUTOMOTIVE_BUNDLE_FILES) rmSync(join(o.out, f), { force: true });
  const golden = checkAutomotiveGolden(o.root);
  if (!golden.ok) return harnessFailure(`harness integrity: ${golden.error}; no adapter was started and no report was produced`);

  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "corpus.jsonl"), golden.bytes);

  const run = await runAutomotiveCorpus(golden.entries, o.adapter, { timeoutMs: o.timeoutMs });
  const harnessIdentity = o.harnessIdentity ?? readAutomotiveHarnessIdentity(o.root);
  let bundle;
  try {
    bundle = buildAutomotiveBundle({ entries: golden.entries, corpusBytes: golden.bytes, run, harnessIdentity });
  } catch (e) {
    if (e instanceof AutomotiveReportBuildError) return harnessFailure(`report build: ${e.message}`);
    throw e;
  }
  const manifestValid = validateAutomotiveManifest(bundle.manifest);
  const reportValid = validateAutomotiveReport(bundle.report);
  if (!manifestValid.ok || !reportValid.ok) {
    return { exitCode: 2, stdout: { ok: false, error: "schema validation failed; no report was written", manifest_errors: manifestValid.errors, report_errors: reportValid.errors } };
  }
  writeFileSync(join(o.out, "evidence.jsonl"), bundle.evidenceBytes);
  writeFileSync(join(o.out, "manifest.json"), prettyJsonFile(bundle.manifest));
  writeFileSync(join(o.out, "report.json"), prettyJsonFile(bundle.report));
  writeFileSync(join(o.out, "summary.md"), bundle.summary);

  const r = bundle.report;
  const harnessInvalid = !r.run_valid || r.scenario_summary.verdict_counts.HARNESS_ERROR > 0;
  const exitCode = harnessInvalid ? 2 : r.scenario_summary.verdict_counts.VIOLATION > 0 ? 1 : 0;
  return {
    exitCode,
    stdout: {
      out: o.out,
      report_schema_valid: reportValid.ok,
      manifest_schema_valid: manifestValid.ok,
      run_valid: r.run_valid,
      complete_execution: r.complete_execution,
      all_required_assessed: r.all_required_assessed,
      scenario_verdicts: r.scenario_summary.verdict_counts,
      not_run: r.scenario_summary.not_run_scenarios,
      corpus_sha256: r.manifest.corpus.sha256,
      evidence_sha256: r.manifest.evidence.sha256,
      exit_code: exitCode,
    },
  };
}

// ---------------------------------------------------------------- faults

export type FaultsOptions = { root: string; out: string; harnessIdentity?: AutomotiveHarnessIdentity } & Partial<Pick<AutomotiveFaultGateOptions, "faultSetFile" | "referenceAdapter" | "faultAdapter" | "timeoutMs">>;

/**
 * Synthetic fault-sensitivity gate: in-repo reference baseline and in-repo synthetic fault agent only. The
 * adapter overrides exist for the gate's own negative-control tests; the CLI never exposes them.
 */
export async function faultsAutomotive(o: FaultsOptions): Promise<CliResult> {
  for (const f of AUTOMOTIVE_FAULT_OUTPUT_FILES) rmSync(join(o.out, f), { force: true });
  for (const d of AUTOMOTIVE_FAULT_OUTPUT_DIRS) rmSync(join(o.out, d), { recursive: true, force: true });
  const golden = checkAutomotiveGolden(o.root);
  if (!golden.ok) return { exitCode: 2, stdout: { ok: false, error: `harness integrity: ${golden.error}; no adapter was started and no fault report was produced`, exit_code: 2 } };
  mkdirSync(o.out, { recursive: true });
  const harnessIdentity = o.harnessIdentity ?? readAutomotiveHarnessIdentity(o.root);
  return runAutomotiveFaultGate({ ...o, entries: golden.entries, corpusBytes: golden.bytes, harnessIdentity });
}

// ---------------------------------------------------------------- file commands

function readJsonFile(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, error: `cannot read JSON from ${file}: ${(e as Error).message}` };
  }
}

export function validateFileCommand(kind: "report" | "manifest" | "fault-report", file: string): CliResult {
  const doc = readJsonFile(file);
  if (!doc.ok) return { exitCode: 2, stdout: { ok: false, errors: [doc.error] } };
  const r = kind === "report" ? validateAutomotiveReport(doc.value) : kind === "manifest" ? validateAutomotiveManifest(doc.value) : validateAutomotiveFaultReport(doc.value);
  return { exitCode: r.ok ? 0 : 2, stdout: { ok: r.ok, errors: r.errors } };
}

export function summaryCommand(file: string): CliResult {
  const doc = readJsonFile(file);
  if (!doc.ok) return { exitCode: 2, stdout: { ok: false, errors: [doc.error] } };
  const v = validateAutomotiveReport(doc.value);
  if (!v.ok) return { exitCode: 2, stdout: { ok: false, errors: v.errors } };
  return { exitCode: 0, stdout: renderAutomotiveSummary(doc.value as AutomotiveReport) };
}

// ---------------------------------------------------------------- argument parsing

interface ParsedArgs {
  cmd: string;
  flags: Map<string, string | true>;
  adapterArgs: string[];
}

const VALUE_FLAGS = new Set(["profile", "adapter-command", "adapter-arg", "out", "timeout-ms", "file"]);
const BOOLEAN_FLAGS = new Set(["reference-agent"]);

export function parseAutomotiveArgs(argv: readonly string[]): ParsedArgs {
  const [cmd = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const adapterArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option --${name}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    i++;
    if (name === "adapter-arg") adapterArgs.push(value); // taken verbatim, even if it starts with "--"
    else if (flags.has(name)) throw new Error(`--${name} given twice`);
    else flags.set(name, value);
  }
  return { cmd, flags, adapterArgs };
}

const REFERENCE_AGENT_MAIN = () => join(__dirname, "adapter", "automotive-reference", "main.js");

export async function automotiveMain(argv: readonly string[], root = AUTOMOTIVE_REPO_ROOT): Promise<CliResult> {
  let p: ParsedArgs;
  try {
    p = parseAutomotiveArgs(argv);
  } catch (e) {
    return { exitCode: 2, stdout: { ok: false, error: (e as Error).message } };
  }
  const str = (k: string) => {
    const v = p.flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const usage = (error: string): CliResult => ({ exitCode: 2, stdout: { ok: false, error } });
  switch (p.cmd) {
    case "evaluate": {
      const profile = str("profile") ?? "smoke";
      if (profile !== "smoke") return usage(`unsupported automotive profile ${JSON.stringify(profile)}; only "smoke" exists in auto-0.2.0`);
      const out = str("out");
      if (!out) return usage("--out is required");
      const reference = p.flags.get("reference-agent") === true;
      const command = str("adapter-command");
      if (reference === (command !== undefined)) return usage("exactly one adapter source is required: --reference-agent or --adapter-command");
      if (reference && p.adapterArgs.length > 0) return usage("--adapter-arg is only valid with --adapter-command");
      let timeoutMs: number | undefined;
      const t = str("timeout-ms");
      if (t !== undefined) {
        if (!/^[1-9][0-9]*$/.test(t)) return usage("--timeout-ms must be a positive integer");
        timeoutMs = Number(t);
      }
      const adapter: AutomotiveAdapterCommand = reference ? { command: process.execPath, args: [REFERENCE_AGENT_MAIN()] } : { command: command!, args: [...p.adapterArgs] };
      return evaluateAutomotive({ root, out, adapter, timeoutMs });
    }
    case "validate-report":
    case "validate-manifest": {
      const file = str("file");
      if (!file) return usage("--file is required");
      return validateFileCommand(p.cmd === "validate-report" ? "report" : "manifest", file);
    }
    case "faults": {
      const profile = str("profile") ?? "smoke";
      if (profile !== "smoke") return usage(`unsupported automotive profile ${JSON.stringify(profile)}; only "smoke" exists in auto-0.2.0`);
      const out = str("out");
      if (!out) return usage("--out is required");
      if (p.flags.has("reference-agent") || p.flags.has("adapter-command") || p.adapterArgs.length > 0 || p.flags.has("timeout-ms")) return usage("faults always uses the in-repo reference baseline and synthetic fault agent; adapter options are not accepted");
      return faultsAutomotive({ root, out });
    }
    case "validate-fault-report": {
      const file = str("file");
      if (!file) return usage("--file is required");
      return validateFileCommand("fault-report", file);
    }
    case "summary": {
      const file = str("file");
      if (!file) return usage("--file is required");
      return summaryCommand(file);
    }
    default:
      return usage(`unknown command ${JSON.stringify(p.cmd)}; commands: evaluate, validate-report, validate-manifest, summary, faults, validate-fault-report`);
  }
}

if (require.main === module) {
  automotiveMain(process.argv.slice(2)).then(
    (r) => {
      process.stdout.write(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout) + "\n");
      process.exitCode = r.exitCode;
    },
    (e) => {
      process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
      process.stdout.write(JSON.stringify({ ok: false, error: `internal error: ${(e as Error).message}` }) + "\n");
      process.exitCode = 2;
    },
  );
}
