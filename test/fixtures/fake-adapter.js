// Misbehaving adapters for protocol contract tests. Mode is argv[2].
const readline = require("node:readline");
const mode = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let n = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    if (mode === "bad-protocol") return out({ type: "hello", protocol_version: 2, adapter: "fake", adapter_version: "0", sut: { name: "x", commit: "c", version: "v", worktree_clean: true } });
    if (mode === "wrong-sut") return out({ type: "hello", protocol_version: 1, adapter: "fake", adapter_version: "0", sut: { name: "x", commit: "0".repeat(40), version: "v", worktree_clean: true } });
    return out({ type: "hello", protocol_version: 1, adapter: "fake", adapter_version: "0", sut: { name: "x", commit: "403d31593a0d57187df3f5e1ef3df6127baaefb9", version: "0.4.0", worktree_clean: true } });
  }
  if (msg.type === "shutdown") process.exit(0);
  n++;
  const c = msg.case;
  const base = { type: "case_result", case_id: c.case_id, protocol_version: 1, evaluation_boundary: c.evaluation_boundary };
  switch (mode) {
    case "crash":
      if (n === 2) process.exit(9);
      return out({ ...base, status: "ok", observations: { assertions: [], executions: {}, unattributed_executions: 0 }, raw_sut_evidence: null });
    case "garbage":
      return process.stdout.write("this is not json\n");
    case "wrong-id":
      return out({ ...base, case_id: "case-other", status: "ok", observations: { assertions: [], executions: {}, unattributed_executions: 0 }, raw_sut_evidence: null });
    case "bad-outcome":
      return out({ ...base, status: "ok", observations: { assertions: [{ step: 0, stage: "request", outcome: "MAYBE", reason_class: "POLICY_DENY", sut_reason_code: "", enforcement_stage: "" }], executions: {}, unattributed_executions: 0 }, raw_sut_evidence: null });
    case "unknown-reason":
      return out({ ...base, status: "ok", observations: { assertions: [{ step: 0, stage: "request", outcome: "DENY", reason_class: "SOMETHING_ELSE", sut_reason_code: "", enforcement_stage: "" }], executions: {}, unattributed_executions: 0 }, raw_sut_evidence: null });
    case "adapter-error":
      return out({ ...base, status: "adapter_error", observations: null, raw_sut_evidence: null, error: { message: "boom" } });
    case "hang":
      return;
    case "deny-everything":
      return out({ ...base, status: "ok", observations: { assertions: [{ step: 0, stage: "request", outcome: "DENY", reason_class: "POLICY_DENY", sut_reason_code: "", enforcement_stage: "" }], executions: {}, unattributed_executions: 0 }, raw_sut_evidence: null });
    default:
      process.exit(7);
  }
});
