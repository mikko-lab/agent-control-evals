import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { canonicalJson, canonicalJsonLines } from './util/canonical-json';
import { sha256Hex } from './util/hash';
import { generateCorpus } from './corpus/revocation/cases';
import { expected } from './oracle/revocation/expected';
import { observe } from './adapter/revocation-reference/runtime';
import { evaluate } from './eval/revocation/evaluate';
import { faultRuns } from './eval/revocation/self-test';
import { buildReport, Report, reportJson, summary } from './report/revocation/report';
import { validateReport } from './report/revocation/validate';
import { VERSION } from './spec/revocation/model';
import { runtimeCommand } from './eval/revocation/runtime-cli';

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  if (!['self-test', 'evaluate'].includes(command)) throw new Error('Usage: ace:revocation self-test --out DIR | evaluate --observations FILE --out DIR | run-adapter --lock FILE --profile FILE --out DIR [--work DIR] [--sut-source PATH] [--verify-baseline] | mutants --lock FILE --profile FILE --out DIR [--work DIR] [--sut-source PATH] [--only IDS] | evaluate --observations FILE --lock FILE --profile FILE --out DIR');
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--out', ...(command === 'evaluate' ? ['--observations'] : [])].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error('Invalid or duplicate option');
    options.set(key, value);
  }
  if (!options.has('--out') || command === 'evaluate' && !options.has('--observations')) throw new Error('Required option missing');
  const root = resolve(__dirname, '..', '..');
  const cases = generateCorpus();
  const corpus = canonicalJsonLines(cases), hash = sha256Hex(corpus);
  if (readFileSync(join(root, 'corpus/revocation/smoke.jsonl'), 'utf8') !== corpus || readFileSync(join(root, 'corpus/revocation/smoke.sha256'), 'utf8').trim() !== hash) throw new Error('Revocation corpus golden mismatch');
  // Compute every oracle result before invoking any runtime or reading observations.
  const truths = cases.map(expected);
  let observations: unknown[];
  let input_observations_sha256: string | null = null;
  if (command === 'self-test') observations = cases.map(c => observe(c));
  else {
    const raw = readFileSync(resolve(options.get('--observations')!));
    input_observations_sha256 = sha256Hex(raw);
    const imported: unknown = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(imported) || imported.length !== cases.length) throw new Error('Expected exactly one observation per corpus case');
    const ids = imported.map(o => typeof o === 'object' && o !== null ? (o as { case_id?: unknown }).case_id : undefined);
    if (new Set(ids).size !== cases.length || cases.some(c => !ids.includes(c.id))) throw new Error('Observation case set mismatch');
    observations = cases.map(c => imported.find((_, i) => ids[i] === c.id));
  }
  const evidence = cases.map((c, i) => evaluate(c, truths[i], observations[i]));
  const source = command === 'self-test' ? 'synthetic_harness_trace' : 'external_adapter_declared_unverified';
  const report = buildReport(evidence, hash, source);
  const out = resolve(options.get('--out')!);
  mkdirSync(dirname(out), { recursive: true });
  // A fresh directory prevents old reports from becoming apparent evidence of this run.
  mkdirSync(out);
  const files: { path: string; sha256: string }[] = [];
  const write = (path: string, content: string) => { mkdirSync(resolve(out, path, '..'), { recursive: true }); writeFileSync(join(out, path), content); files.push({ path, sha256: sha256Hex(content) }); };
  const bundle = (prefix: string, obs: unknown[], r: Report) => {
    const errors = validateReport(r); if (errors.length) throw new Error(errors.join('; '));
    write(`${prefix}observations.json`, canonicalJson(obs) + '\n');
    write(`${prefix}evidence.jsonl`, canonicalJsonLines(r.evidence));
    write(`${prefix}report.json`, reportJson(r));
    write(`${prefix}summary.md`, summary(r));
  };
  write('corpus.jsonl', corpus);
  bundle('', observations, report);
  let gate = report.acceptance_passed;
  if (command === 'self-test') {
    const runs = faultRuns(cases, truths);
    for (const r of runs) bundle(`faults/${r.fault}/`, r.observations, buildReport(r.evidence, hash, source));
    gate = gate && runs.every(r => r.killed);
    write('sensitivity.json', canonicalJson({ version: VERSION, baseline_passed: report.acceptance_passed, gate_passed: gate, faults: runs.map(({ observations: _o, evidence: _e, ...rest }) => rest), note: 'Witnesses are fixed before the run. also_satisfies lists other declared witnesses a fault also triggers; faults are not claimed to be mutually distinguishable.' }) + '\n');
  }
  const implementationPaths = [
    'dist/src/revocation-cli.js', 'dist/src/spec/revocation/model.js',
    'dist/src/corpus/revocation/cases.js', 'dist/src/corpus/revocation/design.js', 'dist/src/oracle/revocation/expected.js',
    'dist/src/adapter/revocation-reference/runtime.js', 'dist/src/eval/revocation/evaluate.js',
    'dist/src/eval/revocation/self-test.js', 'dist/src/report/revocation/report.js',
    'dist/src/report/revocation/validate.js', 'dist/src/util/canonical-json.js', 'dist/src/util/hash.js',
    'dist/schemas/revocation/observation.schema.json', 'dist/schemas/revocation/report.schema.json',
    'package-lock.json',
  ];
  const implementation = implementationPaths.map(path => ({ path, sha256: sha256Hex(readFileSync(join(root, path))) }));
  // Binds the compiled harness, compiled schemas and lockfile bytes; not installed dependencies, Node.js or any external SUT.
  writeFileSync(join(out, 'manifest.json'), canonicalJson({ version: VERSION, observation_source: source, corpus_sha256: hash, input_observations_sha256, implementation_sha256: sha256Hex(canonicalJson(implementation)), implementation, files }) + '\n');
  console.log(canonicalJson({ ...report.counts, technically_valid: report.technically_valid, has_confirmed_violation: report.has_confirmed_violation, acceptance_passed: report.acceptance_passed, gate_passed: gate }));
  if (command === 'self-test') return gate ? 0 : 2;
  // Fail closed: 2 whenever the evaluation is technically invalid or incomplete, even with retained confirmed violations.
  return report.acceptance_passed ? 0 : report.technically_valid && report.counts.VIOLATION > 0 ? 1 : 2;
}
const [command, ...rest] = process.argv.slice(2);
if (command === 'run-adapter' || command === 'mutants' || (command === 'evaluate' && (rest.includes('--profile') || rest.includes('--lock')))) {
  // Declared-profile mode against the pinned runtime (revocation-0.4.0).
  runtimeCommand(command, rest).then(code => { process.exitCode = code; }, error => { console.error(String(error)); process.exitCode = 2; });
} else {
  try { process.exitCode = main(); } catch (error) { console.error(String(error)); process.exitCode = 2; }
}
