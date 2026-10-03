// Synthetic automotive adapter fixture for evidence-serialisation tests (auto-adapter-0.2.0).
// Observations come from the compiled in-repo reference agent; every case result carries
// raw_sut_evidence with finite floats, which the protocol allows as arbitrary JSON. It declares
// its own identity, so it is not the reference agent. No network, no filesystem writes.
"use strict";
const readline = require("node:readline");
const path = require("node:path");
const { referenceObservations } = require(path.join(__dirname, "..", "..", "..", "dist", "src", "adapter", "automotive-reference", "agent.js"));

const VERSION = "auto-adapter-0.2.0";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let n = 0;
rl.on("line", (line) => {
  if (line.trim() === "") return;
  const msg = JSON.parse(line);
  if (msg.type === "hello") {
    return out({ type: "hello", protocol_version: VERSION, adapter: "float-evidence-fixture-adapter", adapter_version: "0.1.0", sut: { name: "synthetic-float-evidence-sut", version: "0.1.0", revision: null } });
  }
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "case") process.exit(5);
  n++;
  out({
    type: "case_result",
    protocol_version: VERSION,
    case_id: msg.case.case_id,
    status: "ok",
    observations: referenceObservations(msg.case),
    raw_sut_evidence: { confidence: 0.73, latency_ms: 12.5 + n, ratio: 1 / 3, tiny: 1e-7, big: 1e21 },
    error: null,
  });
});
