/**
 * Synthetic fault agent process: speaks auto-adapter-0.1.0 over JSON Lines on stdin/stdout,
 * with exactly one active behaviour fault chosen on the command line.
 *
 *   node dist/src/adapter/automotive-faults/main.js <fault_id>
 *
 * raw_sut_evidence carries { fault_id, activated } for diagnosis only.
 */
import { createInterface } from "node:readline";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCaseResult, HarnessToAutomotiveAdapter } from "../automotive/protocol";
import { AUTOMOTIVE_FAULT_IDS, faultHello, faultObservations, isAutomotiveFaultId } from "./agent";

function main(): void {
  const fault = process.argv[2];
  if (!isAutomotiveFaultId(fault)) {
    process.stderr.write(`fault agent: unknown fault ${JSON.stringify(fault)}; known: ${AUTOMOTIVE_FAULT_IDS.join(", ")}\n`);
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let msg: HarnessToAutomotiveAdapter;
    try {
      msg = JSON.parse(line) as HarnessToAutomotiveAdapter;
    } catch {
      process.stderr.write("fault agent: invalid JSON line\n");
      process.exit(3);
    }
    if (msg.protocol_version !== AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION) {
      process.stderr.write(`fault agent: unsupported protocol_version ${String(msg.protocol_version)}\n`);
      process.exit(3);
    }
    if (msg.type === "hello") return write(faultHello(fault));
    if (msg.type === "shutdown") process.exit(0);
    if (msg.type === "case") {
      const { observations, activated } = faultObservations(msg.case, fault);
      // The case identifier is only echoed back, as the protocol requires; it never selects behaviour.
      const result: AutomotiveCaseResult = { type: "case_result", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION, case_id: msg.case.case_id, status: "ok", observations, raw_sut_evidence: { fault_id: fault, activated }, error: null };
      return write(result);
    }
    process.stderr.write("fault agent: unknown message type\n");
    process.exit(3);
  });
}

main();
