/**
 * ACS adapter process (protocol v1). Usage:
 *   node dist/src/adapter/acs/main.js --sut-build <dir> --sut-checkout <dir>
 *
 * Reads one JSON message per stdin line and writes exactly one JSON response
 * line per message to stdout. Cases are processed strictly sequentially.
 * Diagnostics go to stderr only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, type CaseResult, type HarnessToAdapter } from "../protocol";
import { loadSut } from "./sut";
import { AdapterError, makeKeys, runRuntimeCase } from "./runtime";
import { runPermitCase, runVerifierCase } from "./component";
import type { CaseForAdapter } from "../../corpus/types";

import { ADAPTER_NAME, ADAPTER_VERSION } from "./version";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

async function runCase(c: CaseForAdapter, sut: ReturnType<typeof loadSut>, keys: ReturnType<typeof makeKeys>): Promise<CaseResult> {
  const base = { type: "case_result" as const, case_id: c.case_id, protocol_version: PROTOCOL_VERSION, evaluation_boundary: c.evaluation_boundary };
  try {
    let r;
    if (c.evaluation_boundary === "runtime" && c.scenario.kind === "runtime") r = await runRuntimeCase(c, sut, keys);
    else if (c.evaluation_boundary === "component" && c.scenario.kind === "component" && c.scenario.component === "approval_grant_verifier") r = runVerifierCase(c, sut, keys);
    else if (c.evaluation_boundary === "component" && c.scenario.kind === "component" && c.scenario.component === "execution_gate") r = await runPermitCase(c, sut);
    else throw new AdapterError(`unsupported boundary/scenario combination ${c.evaluation_boundary}/${c.scenario.kind}`);
    return { ...base, status: "ok", observations: r.observations, raw_sut_evidence: r.evidence };
  } catch (e) {
    const err = e as Error;
    // Observations are withheld (the case is not evaluated), but everything observed before the error,
    // including tool-double executions, is kept as raw evidence next to the error.
    const partial = (err as Error & { partial?: unknown })?.partial ?? null;
    return { ...base, status: "adapter_error", observations: null, raw_sut_evidence: { partial }, error: { message: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}` } };
  }
}

async function main(): Promise<void> {
  const buildDir = arg("--sut-build");
  const checkout = arg("--sut-checkout");
  const sut = loadSut(buildDir);
  const keys = makeKeys();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const worktreeClean = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout, encoding: "utf8" }).trim() === "";
  const version = (JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as { version: string }).version;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let msg: HarnessToAdapter;
    try {
      msg = JSON.parse(line) as HarnessToAdapter;
    } catch {
      process.stderr.write("protocol error: invalid JSON line\n");
      process.exit(3);
    }
    if (msg.protocol_version !== PROTOCOL_VERSION) {
      process.stderr.write(`protocol error: unsupported protocol_version ${String(msg.protocol_version)}\n`);
      process.exit(3);
    }
    if (msg.type === "hello") {
      write({ type: "hello", protocol_version: PROTOCOL_VERSION, adapter: ADAPTER_NAME, adapter_version: ADAPTER_VERSION, sut: { name: "acs-guardrail-demo", commit, version, worktree_clean: worktreeClean } });
    } else if (msg.type === "case") {
      write(await runCase(msg.case, sut, keys));
    } else if (msg.type === "shutdown") {
      break;
    } else {
      process.stderr.write(`protocol error: unknown message type\n`);
      process.exit(3);
    }
  }
}

main().catch((e) => {
  process.stderr.write(`adapter fatal: ${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(4);
});
