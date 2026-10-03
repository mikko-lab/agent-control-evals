import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMOTIVE_FAULT_STATUSES } from "../../src/fault/automotive/types";
import { AUTOMOTIVE_FAULT_REPORT_LIMITATIONS } from "../../src/fault/automotive/limitations";
import { loadAutomotiveFaultSchema, validateAutomotiveFaultReport, validateAutomotiveFaultSetSchema } from "../../src/fault/automotive/validate";
import { EXECUTABLE_AUTOMOTIVE_DOMAINS } from "../../src/spec/automotive/domains";
import { AUTOMOTIVE_VERDICTS } from "../../src/spec/automotive/outcomes";
import { AUTOMOTIVE_VIOLATION_REASONS } from "../../src/spec/automotive/reason-taxonomy";
import { AUTOMOTIVE_FAULT_ADAPTER_VERSION, AUTOMOTIVE_FAULT_REPORT_VERSION, AUTOMOTIVE_FAULT_SET_VERSION, AUTOMOTIVE_PACK_VERSION } from "../../src/spec/automotive/version";
import { AUTOMOTIVE_SMOKE_CORPUS_IDENTITY } from "../../src/corpus/automotive/profiles";
import { AUTOMOTIVE_CASE_ID_PATTERN, AUTOMOTIVE_VARIANT_PATTERN, PROBE_FIELDS } from "../../src/corpus/automotive/types";
import { AUTOMOTIVE_FAULT_IDS } from "../../src/adapter/automotive-faults/agent";

const ROOT = join(__dirname, "..", "..", "..");
const set = loadAutomotiveFaultSchema("fault-set") as any;
const rep = loadAutomotiveFaultSchema("fault-report") as any;
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "faults", "automotive", "manifest.json"), "utf8"));

test("schema/code parity: versions, domains, probe fields, VIOLATION reasons, fault statuses, verdicts", () => {
  assert.equal(set.properties.fault_set_version.const, AUTOMOTIVE_FAULT_SET_VERSION);
  assert.equal(rep.properties.fault_set_version.const, AUTOMOTIVE_FAULT_SET_VERSION);
  assert.equal(rep.properties.fault_report_version.const, AUTOMOTIVE_FAULT_REPORT_VERSION);
  assert.equal(rep.properties.fault_adapter_version.const, AUTOMOTIVE_FAULT_ADAPTER_VERSION);
  assert.equal(rep.properties.pack_version.const, AUTOMOTIVE_PACK_VERSION);
  assert.equal(rep.properties.profile.const, AUTOMOTIVE_SMOKE_CORPUS_IDENTITY.profile);
  for (const s of [set, rep]) {
    assert.deepEqual(s.$defs.domain.enum, [...EXECUTABLE_AUTOMOTIVE_DOMAINS]);
    assert.deepEqual(s.$defs.field, { oneOf: [{ type: "null" }, { enum: [...PROBE_FIELDS] }] });
    assert.deepEqual(s.$defs.fieldForDomain.else.properties.expected_field.enum, [...PROBE_FIELDS]);
    assert.deepEqual(s.$defs.reasons.items.enum, [...AUTOMOTIVE_VIOLATION_REASONS]);
    assert.equal(s.$defs.variants.items.pattern, AUTOMOTIVE_VARIANT_PATTERN);
  }
  assert.deepEqual(rep.$defs.faultResult.properties.status.enum, [...AUTOMOTIVE_FAULT_STATUSES]);
  assert.deepEqual(rep.$defs.verdictCounts.required, [...AUTOMOTIVE_VERDICTS]);
  assert.equal(rep.$defs.caseId.pattern, AUTOMOTIVE_CASE_ID_PATTERN);
  assert.equal(rep.properties.limitations.minItems, AUTOMOTIVE_FAULT_REPORT_LIMITATIONS.length);
  for (const id of AUTOMOTIVE_FAULT_IDS) assert.match(id, new RegExp(set.$defs.faultId.pattern));
});

test("both fault schemas are closed 2020-12 schemas", () => {
  const open: string[] = [];
  const walk = (node: any, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node === null || typeof node !== "object") return;
    if (node.type === "object" && node.properties && node.additionalProperties !== false) open.push(path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  for (const [name, s] of [["fault-set", set], ["fault-report", rep]] as const) {
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(s.$id, `https://github.com/mikko-lab/agent-control-evals/schemas/automotive/${name}.schema.json`);
    walk(s, name);
  }
  assert.deepEqual(open, []);
});

test("the committed fault set validates; malformed fault sets and unsupported versions fail", () => {
  assert.deepEqual(validateAutomotiveFaultSetSchema(MANIFEST), { ok: true, errors: [] });
  const bad = (what: string, mutate: (d: any) => void) => {
    const d = structuredClone(MANIFEST);
    mutate(d);
    assert.equal(validateAutomotiveFaultSetSchema(d).ok, false, what);
  };
  bad("future version", (d) => (d.fault_set_version = "auto-faults-0.3.0"));
  bad("previous version", (d) => (d.fault_set_version = "auto-faults-0.1.0"));
  bad("null field outside recommendation_integrity", (d) => (d.faults[0].expected_field = null));
  bad("field on a recommendation fault", (d) => (d.faults.at(-1).expected_field = "price"));
  bad("severity", (d) => (d.faults[0].severity = "high"));
  bad("bad fault id", (d) => (d.faults[0].fault_id = "fault one"));
  bad("non-VIOLATION reason", (d) => (d.faults[0].expected_reasons = ["TIMEOUT"]));
  bad("whitespace description", (d) => (d.faults[0].description = "   "));
  bad("bad variant", (d) => (d.faults[0].witness_variants = ["Bad Variant"]));
  assert.match(validateAutomotiveFaultSetSchema({ ...MANIFEST, fault_set_version: "auto-faults-9.9.9" }).errors[0], /unsupported fault_set_version/);
});

function sampleReport(): any {
  const counts = { PASS: 23, VIOLATION: 1, UNASSESSABLE: 0, HARNESS_ERROR: 0 };
  return {
    fault_report_version: AUTOMOTIVE_FAULT_REPORT_VERSION,
    fault_set_version: AUTOMOTIVE_FAULT_SET_VERSION,
    fault_set_sha256: "b".repeat(64),
    fault_adapter_version: AUTOMOTIVE_FAULT_ADAPTER_VERSION,
    pack_version: AUTOMOTIVE_PACK_VERSION,
    profile: "auto-smoke-0.2.0",
    corpus_sha256: "c".repeat(64),
    harness: { commit: "unknown", worktree_clean: false },
    baseline: { report_path: "baseline/report.json", evidence_sha256: "d".repeat(64), run_valid: true, complete_execution: true, all_required_assessed: true, verdict_counts: { PASS: 24, VIOLATION: 0, UNASSESSABLE: 0, HARNESS_ERROR: 0 } },
    gate: { passed: false, fault_count: 2, killed: 1, survived: 0, invalid: 1 },
    faults: [
      {
        fault_id: "AF05-total-required-basis-bypass",
        domain: "price_attribution",
        description: "Mandatory-fee basis bypass fault.",
        expected_field: "price",
        expected_reasons: ["PRICE_BASIS_MISMATCH"],
        witness_variants: ["total_required_with_fees"],
        status: "killed",
        invalid_reason: null,
        witness_case_ids: ["auto-case-000009"],
        matched_witness_case_ids: ["auto-case-000009"],
        collateral_violation_case_ids: [],
        run_valid: true,
        verdict_counts: counts,
        report_path: "faults/AF05-total-required-basis-bypass/report.json",
        evidence_sha256: "e".repeat(64),
      },
      {
        fault_id: "AF06-current-price-currency",
        domain: "price_attribution",
        description: "Wrong currency fault.",
        expected_field: "price",
        expected_reasons: ["CURRENCY_MISMATCH"],
        witness_variants: ["two_listing_current_prices"],
        status: "invalid",
        invalid_reason: "report build failed: synthetic",
        witness_case_ids: ["auto-case-000007"],
        matched_witness_case_ids: [],
        collateral_violation_case_ids: [],
        run_valid: false,
        verdict_counts: null,
        report_path: null,
        evidence_sha256: null,
      },
    ],
    limitations: [...AUTOMOTIVE_FAULT_REPORT_LIMITATIONS],
  };
}

test("fault report schema: a valid report passes; malformed reports and unsupported versions fail", () => {
  assert.deepEqual(validateAutomotiveFaultReport(sampleReport()), { ok: true, errors: [] });
  const bad = (what: string, mutate: (d: any) => void) => {
    const d = sampleReport();
    mutate(d);
    assert.equal(validateAutomotiveFaultReport(d).ok, false, what);
  };
  bad("kill rate", (d) => (d.gate.kill_rate = 1));
  bad("score", (d) => (d.score = 100));
  bad("absolute report path", (d) => (d.faults[0].report_path = "/tmp/out/faults/AF05-total-required-basis-bypass/report.json"));
  bad("absolute baseline path", (d) => (d.baseline.report_path = "/home/x/baseline/report.json"));
  bad("unknown status", (d) => (d.faults[0].status = "partially_killed"));
  bad("killed without a matching witness", (d) => (d.faults[0].matched_witness_case_ids = []));
  bad("killed with an invalid reason", (d) => (d.faults[0].invalid_reason = "x"));
  bad("survived with a matching witness", (d) => (d.faults[0].status = "survived"));
  bad("invalid without a reason", (d) => (d.faults[1].invalid_reason = null));
  bad("killed in an invalid run", (d) => (d.faults[0].run_valid = false));
  bad("bad sha", (d) => (d.fault_set_sha256 = "XYZ"));
  bad("bad commit", (d) => (d.harness.commit = "HEAD"));
  bad("bad case id", (d) => (d.faults[0].witness_case_ids = ["case-9"]));
  bad("too few limitations", (d) => d.limitations.pop());
  bad("severity on a fault", (d) => (d.faults[0].severity = "high"));
  bad("recommendation fault with a field", (d) => ((d.faults[1].domain = "recommendation_integrity"), (d.faults[1].expected_reasons = ["RECOMMENDATION_FALSE_NO_MATCH"])));
  const rec = sampleReport();
  Object.assign(rec.faults[1], { domain: "recommendation_integrity", expected_field: null, expected_reasons: ["RECOMMENDATION_FALSE_NO_MATCH"], witness_variants: ["single_eligible_match"] });
  assert.deepEqual(validateAutomotiveFaultReport(rec), { ok: true, errors: [] });
  for (const v of ["auto-fault-report-0.1.0", "auto-fault-report-0.3.0", undefined, null]) assert.match(validateAutomotiveFaultReport({ ...sampleReport(), fault_report_version: v }).errors[0], /unsupported fault_report_version/);
});
