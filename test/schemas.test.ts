import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { generateCorpus } from "../src/corpus/generate";
import { PROFILES } from "../src/corpus/profiles";
import { forAdapter, runCases } from "../src/eval/run";
import { adapterCommand } from "../src/sut/environment";

const ROOT = join(__dirname, "..", "..");
const load = (f: string) => JSON.parse(readFileSync(join(ROOT, "schemas", f), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(load("case.schema.json"), "case.schema.json");
ajv.addSchema(load("adapter-protocol-v1.schema.json"), "proto");
const smoke = generateCorpus(PROFILES.smoke.seed, PROFILES.smoke.cases).cases;

test("every smoke case validates against the language-independent case schema", () => {
  const v = ajv.getSchema("case.schema.json")!;
  for (const c of smoke) assert.ok(v(c), `${c.case_id}: ${JSON.stringify(v.errors)}`);
});

test("harness->adapter case messages validate against the protocol schema", () => {
  const v = ajv.getSchema("proto#/$defs/harnessToAdapter")!;
  for (const c of smoke.slice(0, 100)) assert.ok(v({ type: "case", protocol_version: 1, case: forAdapter(c) }), JSON.stringify(v.errors));
  assert.equal(v({ type: "case", protocol_version: 1, case: smoke[0] }), false, "a case that still carries `expected` must not validate");
});

const CO = process.env.ACE_SUT_CHECKOUT;
const BUILD = process.env.ACE_SUT_BUILD;
test("real adapter responses validate against the protocol schema", { skip: !CO || !BUILD ? "SUT env not set" : false }, async () => {
  const r = await runCases(smoke.filter((_, i) => i % 10 === 0), adapterCommand(ROOT, CO!, BUILD!), "403d31593a0d57187df3f5e1ef3df6127baaefb9");
  const hello = ajv.getSchema("proto#/$defs/helloResponse")!;
  assert.ok(hello(r.hello), JSON.stringify(hello.errors));
  const v = ajv.getSchema("proto#/$defs/caseResult")!;
  for (const x of r.results) assert.ok(v(x), `${x.case_id}: ${JSON.stringify(v.errors)}`);
});
