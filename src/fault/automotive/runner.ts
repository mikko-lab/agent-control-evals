/**
 * Automotive fault-sensitivity runner: owns I/O and process execution for the fault gate.
 *
 *   validated fault set -> baseline reference run (must be a clean full PASS) ->
 *   every declared fault against the full corpus, through the normal adapter protocol, D1
 *   evaluator and D2 bundle -> pure judge -> fault report -> schema validation -> files.
 *
 * The caller (the CLI) clears stale output and checks the golden corpus first. Exit codes:
 * 0 every declared fault killed; 3 any fault survived or invalid; 2 harness invalid (fault-set,
 * baseline, build or schema failure). Exit 1 is never used here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../util/hash";
import type { AutomotiveCorpusEntry } from "../../corpus/automotive-generation/corpus-entry";
import type { AutomotiveAdapterCommand } from "../../adapter/automotive/jsonl-client";
import { AUTOMOTIVE_FAULT_IDS } from "../../adapter/automotive-faults/agent";
import { runAutomotiveCorpus } from "../../eval/automotive/run";
import { buildAutomotiveBundle } from "../../report/automotive/build";
import { prettyJsonFile } from "../../report/automotive/json";
import { AutomotiveReportBuildError, type AutomotiveBundle, type AutomotiveHarnessIdentity } from "../../report/automotive/types";
import { validateAutomotiveManifest, validateAutomotiveReport } from "../../report/automotive/validate";
import { checkAutomotiveFaultSet } from "./manifest";
import { automotiveBaselineProblems, buildAutomotiveFaultReport } from "./report";
import { renderAutomotiveFaultSummary } from "./summary";
import { AutomotiveFaultGateError, type AutomotiveFaultRunOutcome } from "./types";
import { validateAutomotiveFaultReport } from "./validate";

/** dist/src, as seen from dist/src/fault/automotive. */
const DIST_SRC = join(__dirname, "..", "..");

export const AUTOMOTIVE_FAULT_OUTPUT_FILES = ["fault-set.json", "fault-sensitivity.json", "fault-summary.md"] as const;
export const AUTOMOTIVE_FAULT_OUTPUT_DIRS = ["baseline", "faults"] as const;

export const defaultReferenceAdapter = (): AutomotiveAdapterCommand => ({ command: process.execPath, args: [join(DIST_SRC, "adapter", "automotive-reference", "main.js")] });
export const defaultFaultAdapter = (fault_id: string): AutomotiveAdapterCommand => ({ command: process.execPath, args: [join(DIST_SRC, "adapter", "automotive-faults", "main.js"), fault_id] });

export interface AutomotiveFaultGateOptions {
  root: string;
  out: string;
  /** Golden-checked corpus (the CLI performs the golden precondition). */
  entries: readonly AutomotiveCorpusEntry[];
  corpusBytes: string;
  harnessIdentity: AutomotiveHarnessIdentity;
  /** Defaults to <root>/faults/automotive/manifest.json. */
  faultSetFile?: string;
  referenceAdapter?: AutomotiveAdapterCommand;
  faultAdapter?: (fault_id: string) => AutomotiveAdapterCommand;
  timeoutMs?: number;
}

export interface AutomotiveFaultGateResult {
  exitCode: 0 | 2 | 3;
  stdout: Record<string, unknown>;
}

const harnessInvalid = (error: string): AutomotiveFaultGateResult => ({ exitCode: 2, stdout: { ok: false, error, exit_code: 2 } });

/** Same five files, same bytes, as `evaluate` writes. */
function writeBundle(dir: string, corpusBytes: string, b: AutomotiveBundle): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "corpus.jsonl"), corpusBytes);
  writeFileSync(join(dir, "evidence.jsonl"), b.evidenceBytes);
  writeFileSync(join(dir, "manifest.json"), prettyJsonFile(b.manifest));
  writeFileSync(join(dir, "report.json"), prettyJsonFile(b.report));
  writeFileSync(join(dir, "summary.md"), b.summary);
}

/** One full-corpus run through D1 and D2. Returns a schema-valid bundle or the reason there is none. */
async function bundleRun(o: AutomotiveFaultGateOptions, adapter: AutomotiveAdapterCommand): Promise<{ bundle: AutomotiveBundle } | { failure: string }> {
  const run = await runAutomotiveCorpus(o.entries, adapter, { timeoutMs: o.timeoutMs });
  let bundle: AutomotiveBundle;
  try {
    bundle = buildAutomotiveBundle({ entries: o.entries, corpusBytes: o.corpusBytes, run, harnessIdentity: o.harnessIdentity });
  } catch (e) {
    if (e instanceof AutomotiveReportBuildError) return { failure: `report build failed: ${e.message}` };
    throw e;
  }
  const m = validateAutomotiveManifest(bundle.manifest);
  const r = validateAutomotiveReport(bundle.report);
  if (!m.ok || !r.ok) return { failure: `schema validation failed: ${[...m.errors, ...r.errors].join("; ")}` };
  return { bundle };
}

export async function runAutomotiveFaultGate(o: AutomotiveFaultGateOptions): Promise<AutomotiveFaultGateResult> {
  // Committed fault set: exact bytes are copied to the output and hashed.
  const faultSetFile = o.faultSetFile ?? join(o.root, "faults", "automotive", "manifest.json");
  let faultSetBytes: Buffer;
  let faultSetDoc: unknown;
  try {
    faultSetBytes = readFileSync(faultSetFile);
    faultSetDoc = JSON.parse(faultSetBytes.toString("utf8"));
  } catch (e) {
    return harnessInvalid(`fault set could not be read: ${(e as Error).message}`);
  }
  const check = checkAutomotiveFaultSet(faultSetDoc, o.entries, AUTOMOTIVE_FAULT_IDS);
  if (!check.ok) return harnessInvalid(`invalid fault set: ${check.errors.join("; ")}`);
  const faultSet = check.faultSet;

  // Baseline: the clean in-repo reference agent.
  const baseline = await bundleRun(o, o.referenceAdapter ?? defaultReferenceAdapter());
  if ("failure" in baseline) return harnessInvalid(`baseline: ${baseline.failure}`);
  writeBundle(join(o.out, "baseline"), o.corpusBytes, baseline.bundle);
  const problems = automotiveBaselineProblems(baseline.bundle.report);
  if (problems.length > 0) return harnessInvalid(`baseline is not a clean reference run: ${problems.join("; ")}; no fault sensitivity is claimed`);

  // Every declared fault, in manifest order, against the full corpus.
  const outcomes: AutomotiveFaultRunOutcome[] = [];
  for (const f of faultSet.faults) {
    const r = await bundleRun(o, (o.faultAdapter ?? defaultFaultAdapter)(f.fault_id));
    if ("failure" in r) {
      outcomes.push({ report: null, report_path: null, failure: r.failure });
      continue;
    }
    const rel = `faults/${f.fault_id}`;
    writeBundle(join(o.out, rel), o.corpusBytes, r.bundle);
    outcomes.push({ report: r.bundle.report, report_path: `${rel}/report.json`, failure: null });
  }

  let report;
  try {
    report = buildAutomotiveFaultReport({
      faultSet,
      faultSetSha256: sha256Hex(faultSetBytes),
      baseline: baseline.bundle.report,
      baselineReportPath: "baseline/report.json",
      outcomes,
      harnessIdentity: o.harnessIdentity,
    });
  } catch (e) {
    if (e instanceof AutomotiveFaultGateError) return harnessInvalid(`fault report: ${e.message}`);
    throw e;
  }
  const valid = validateAutomotiveFaultReport(report);
  if (!valid.ok) return harnessInvalid(`fault report schema validation failed: ${valid.errors.join("; ")}`);

  writeFileSync(join(o.out, "fault-set.json"), faultSetBytes);
  writeFileSync(join(o.out, "fault-sensitivity.json"), prettyJsonFile(report));
  writeFileSync(join(o.out, "fault-summary.md"), renderAutomotiveFaultSummary(report));

  const exitCode = report.gate.passed ? 0 : 3;
  return {
    exitCode,
    stdout: {
      out: o.out,
      fault_set_version: report.fault_set_version,
      fault_report_schema_valid: valid.ok,
      baseline_valid: true,
      gate_passed: report.gate.passed,
      fault_count: report.gate.fault_count,
      killed: report.gate.killed,
      survived: report.gate.survived,
      invalid: report.gate.invalid,
      corpus_sha256: report.corpus_sha256,
      fault_set_sha256: report.fault_set_sha256,
      exit_code: exitCode,
    },
  };
}
