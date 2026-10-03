/**
 * Reference agent process: speaks the automotive adapter protocol (auto-adapter-0.1.0)
 * over JSON Lines on stdin/stdout, one message at a time. Diagnostics go to stderr.
 *
 *   node dist/src/adapter/automotive-reference/main.js
 */
import { createInterface } from "node:readline";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCaseResult, HarnessToAutomotiveAdapter } from "../automotive/protocol";
import { referenceHello, referenceObservations } from "./agent";

function main(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let msg: HarnessToAutomotiveAdapter;
    try {
      msg = JSON.parse(line) as HarnessToAutomotiveAdapter;
    } catch {
      process.stderr.write("reference agent: invalid JSON line\n");
      process.exit(3);
    }
    if (msg.protocol_version !== AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION) {
      process.stderr.write(`reference agent: unsupported protocol_version ${String(msg.protocol_version)}\n`);
      process.exit(3);
    }
    if (msg.type === "hello") return write(referenceHello());
    if (msg.type === "shutdown") process.exit(0);
    if (msg.type === "case") {
      let result: AutomotiveCaseResult;
      try {
        result = { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: msg.case.case_id, status: "ok", observations: referenceObservations(msg.case), raw_sut_evidence: null, error: null };
      } catch (e) {
        result = { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: msg.case.case_id, status: "adapter_error", observations: null, raw_sut_evidence: null, error: { message: `reference agent: ${(e as Error).message}` } };
      }
      return write(result);
    }
    process.stderr.write("reference agent: unknown message type\n");
    process.exit(3);
  });
}

main();
