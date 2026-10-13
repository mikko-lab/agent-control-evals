/**
 * External Action Boundary Evaluation, P1a CLI (`npm run ace:external -- <command>`).
 *
 *   self-test --out DIR                                   goldens, full baseline profile, RV1-RV6 and AX1-AX7 against their pins
 *   evaluate --observations FILE --profile FILE --out DIR  recorded synthetic observations (exit 0/1/2/3, plan §7.2)
 *   validate-report --file FILE
 *   oracle-boundary
 *   write-goldens                                         development only: rewrites corpus, fixtures and the baseline observations file
 *   compute-pins                                          development only: prints the regression and mutant results to review before pinning
 *
 * Every result is synthetic harness validation, not a measured security result for any guard.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, canonicalJsonLines } from './util/canonical-json';
import { sha256Hex } from './util/hash';
import { generateCases } from './external-actions/corpus/cases';
import { corpusBytes, evaluateRun, RunResult } from './external-actions/eval/run';
import { ALL_FIXTURES, BASELINE, buildFixture } from './external-actions/fixtures/catalog';
import { checkExternalActionsOracleBoundary } from './external-actions/oracle-boundary';
import { Report, reportJson, summary, validateReport } from './external-actions/report/report';
import { fixtureBytes, loadProfile, MUTANT_INPUTS, PATHS, REGRESSIONS, runMutant, runRegression, selfTest } from './external-actions/self-test';
import { ADAPTER_MUTANTS } from './external-actions/mutation/adapter-mutants';
import { VERSION } from './external-actions/spec/model';
import { loadP1bProfile, loadRunConfig } from './external-actions/p1b/config';
import { envCheck, setupHost } from './external-actions/p1b/env-check';
import { evaluateP1bRun, missingObservation } from './external-actions/p1b/evaluate-run';
import { GateManifest, guardSource, loadRun, runGate, RunSummary } from './external-actions/p1b/gate';
import { P1B_PATHS } from './external-actions/p1b/config';
import { INJECTIONS, Injection } from './external-actions/p1b/orchestrator';
import { handBack, p1bRun, writeRunBundle } from './external-actions/p1b/run';
import { runPrivilegedRegressions } from './external-actions/p1b/regressions';

const root = resolve(__dirname, '..', '..');
const USAGE = 'Usage: ace:external self-test --out DIR | evaluate --observations FILE --profile FILE --out DIR | validate-report --file FILE | oracle-boundary | write-goldens | compute-pins'
  + ' | p1b-setup-host | p1b-env-check | p1b-run --guard ID --out DIR [--inject A,B] [--cases A,B] | p1b-evaluate --run DIR --out DIR | p1b-compare --a DIR --b DIR'
  + ' | p1b-gate --runs DIR --out FILE [--precheck true] | p1b-regressions --out DIR [--control DIR]';

function options(args: string[], allowed: string[], required: string[]): Map<string, string> {
  const o = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i], v = args[i + 1];
    if (!allowed.includes(k) || v === undefined || v.startsWith('--') || o.has(k)) throw new Error(`Invalid or duplicate option ${k}. ${USAGE}`);
    o.set(k, v);
  }
  for (const k of required) if (!o.has(k)) throw new Error(`Required option ${k} missing. ${USAGE}`);
  return o;
}

/** A fresh output directory, so that old files never become apparent evidence of this run. */
function writer(outDir: string) {
  const out = resolve(outDir);
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out);
  const files: { path: string; sha256: string }[] = [];
  const write = (path: string, content: string) => { mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), content); files.push({ path, sha256: sha256Hex(content) }); };
  return { out, files, write };
}
function bundle(write: (p: string, c: string) => void, prefix: string, observations: unknown[], r: RunResult) {
  const errors = validateReport(r.report);
  if (errors.length) throw new Error(`report schema: ${errors.join('; ')}`);
  write(`${prefix}observations.json`, canonicalJson(observations) + '\n');
  write(`${prefix}evidence.jsonl`, canonicalJsonLines(r.report.evidence));
  write(`${prefix}report.json`, reportJson(r.report));
  write(`${prefix}summary.md`, summary(r.report));
}
const IMPLEMENTATION = [
  'dist/src/external-actions-cli.js', 'dist/src/external-actions/spec/model.js', 'dist/src/external-actions/corpus/cases.js',
  'dist/src/external-actions/oracle/expected.js', 'dist/src/external-actions/eval/evaluate.js', 'dist/src/external-actions/eval/run.js',
  'dist/src/external-actions/report/report.js', 'dist/src/external-actions/fixtures/builder.js', 'dist/src/external-actions/fixtures/catalog.js',
  'dist/src/external-actions/mutation/adapter-mutants.js', 'dist/src/external-actions/self-test.js', 'dist/src/external-actions/oracle-boundary.js',
  'dist/src/util/canonical-json.js', 'dist/src/util/hash.js',
  'dist/schemas/external-actions/observation-1.schema.json', 'dist/schemas/external-actions/report-1.schema.json',
  'package-lock.json',
];
function manifest(out: string, files: { path: string; sha256: string }[], extra: Record<string, unknown>) {
  const implementation = IMPLEMENTATION.map(path => ({ path, sha256: sha256Hex(readFileSync(join(root, path))) }));
  // Binds the compiled harness, compiled schemas and lockfile bytes; not installed dependencies or Node.js. Not a signed attestation.
  writeFileSync(join(out, 'manifest.json'), canonicalJson({ version: VERSION, evidence_kind: 'synthetic_harness_validation', ...extra, implementation_sha256: sha256Hex(canonicalJson(implementation)), implementation, files }) + '\n');
}
const brief = (r: Report) => canonicalJson({ ...r.counts, technically_valid: r.technically_valid, has_confirmed_violation: r.has_confirmed_violation, controls_passed: r.controls_passed, profile_acceptance_passed: r.profile_acceptance_passed, contract_acceptance_passed: r.contract_acceptance_passed, exit_code: r.exit_code });

async function p1b(command: string, args: string[]): Promise<number | null> {
  if (command === 'p1b-setup-host') {
    options(args, [], []);
    console.log(JSON.stringify(setupHost(loadRunConfig(root).config)));
    return 0;
  }
  if (command === 'p1b-env-check') {
    options(args, [], []);
    const r = await envCheck(loadRunConfig(root).config);
    console.log(JSON.stringify(r, null, 1));
    return r.ok ? 0 : 2;
  }
  if (command === 'p1b-run') {
    const o = options(args, ['--guard', '--out', '--inject', '--cases'], ['--guard', '--out']);
    const inject = new Set((o.get('--inject') ?? '').split(',').filter(Boolean)) as Set<Injection>;
    for (const x of inject) if (!INJECTIONS.includes(x)) throw new Error(`unknown injection ${x}`);
    const id = o.get('--guard')!;
    const r = await p1bRun({ root, out: o.get('--out')!, guardId: id, guardSource: guardSource(root, id), inject, cases: o.get('--cases')?.split(',') });
    console.log(brief(r.result.report));
    return r.result.report.exit_code;
  }
  if (command === 'p1b-evaluate') {
    const o = options(args, ['--run', '--out'], ['--run', '--out']);
    const run = resolve(o.get('--run')!);
    const { profile, sha256 } = loadP1bProfile(root);
    const { config, sha256: configSha } = loadRunConfig(root);
    const manifestIn = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
    if (manifestIn.development_subset) throw new Error('a development subset run is not evaluated through the recorded path');
    const records = JSON.parse(readFileSync(join(run, 'raw', 'run-records.json'), 'utf8')) as unknown[];
    const observations = profile.cases.map(id => { try { return JSON.parse(readFileSync(join(run, 'raw', `${id}.observation.json`), 'utf8')); } catch { return missingObservation(id); } });
    const result = evaluateP1bRun(profile, sha256, config, { observations, records });
    const out = resolve(o.get('--out')!);
    mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
    writeRunBundle(root, out, sha256, configSha, manifestIn.guard, observations.filter(x => !(x as { missing?: boolean }).missing), records, result, { command: 'p1b-evaluate', input_run_manifest_sha256: sha256Hex(readFileSync(join(run, 'manifest.json'))) });
    console.log(brief(result.report));
    return result.report.exit_code;
  }
  if (command === 'p1b-compare') {
    const o = options(args, ['--a', '--b'], ['--a', '--b']);
    const a = readFileSync(join(resolve(o.get('--a')!), 'canonical.json'), 'utf8'), b = readFileSync(join(resolve(o.get('--b')!), 'canonical.json'), 'utf8');
    if (a === b) { console.log(JSON.stringify({ identical: true, sha256: sha256Hex(a) })); return 0; }
    const ca = JSON.parse(a) as unknown[], cb = JSON.parse(b) as unknown[];
    ca.forEach((x, i) => { if (canonicalJson(x) !== canonicalJson(cb[i])) console.error(`differs: case ${i} ${JSON.stringify((x as { record?: { case_id?: string } }).record?.case_id)}`); });
    return 1;
  }
  if (command === 'p1b-regressions') {
    const o = options(args, ['--out', '--control'], ['--out']);
    const out = resolve(o.get('--out')!);
    mkdirSync(out, { recursive: true });
    const r = await runPrivilegedRegressions(root, out, o.has('--control') ? resolve(o.get('--control')!) : null);
    writeFileSync(join(out, 'regressions.json'), JSON.stringify(r, null, 1) + '\n');
    handBack(out);
    console.log(JSON.stringify({ ok: r.ok, results: r.results.map(x => `${x.id}:${x.ok}`), control: r.control }));
    return r.ok ? 0 : 2;
  }
  if (command === 'p1b-gate') {
    const o = options(args, ['--runs', '--out', '--precheck'], ['--runs', '--out']);
    const precheck = o.has('--precheck') ? o.get('--precheck') === 'true' : false;
    const manifestBytes = readFileSync(join(root, P1B_PATHS.mutants));
    if (!precheck && readFileSync(join(root, P1B_PATHS.mutantsSha), 'utf8').trim() !== sha256Hex(manifestBytes)) throw new Error('guard mutant manifest sha256 pin does not match');
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as GateManifest;
    const dir = resolve(o.get('--runs')!);
    const runs: Record<string, RunSummary | null> = { reference: loadRun(join(dir, 'reference')) };
    for (const m of manifest.mutants) runs[m.id] = loadRun(join(dir, m.id));
    for (const extra of readdirSync(dir)) if (!(extra in runs)) runs[extra] = loadRun(join(dir, extra));
    const r = runGate(root, manifest, runs, precheck);
    const out = resolve(o.get('--out')!);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, canonicalJson({ manifest_sha256: sha256Hex(manifestBytes), precheck, ...r }) + '\n');
    for (const x of r.issues) console.error(x);
    console.log(JSON.stringify({ passed: r.passed, precheck, issues: r.issues.length, mutants: r.mutants.map(m => ({ id: m.id, ok: m.ok, masked: m.masked, changed: m.changed_cases.length, deviations: m.deviations_observed.length })) }));
    return r.passed ? 0 : precheck ? 3 : 2;
  }
  return null;
}

function main(command: string | undefined, args: string[]): number {
  if (command === 'self-test') {
    const o = options(args, ['--out'], ['--out']);
    const result = selfTest(root);
    const { out, files, write } = writer(o.get('--out')!);
    const { profile, sha256 } = loadProfile(root);
    write('corpus.jsonl', corpusBytes());
    bundle(write, 'baseline/', profile.cases.map(id => buildFixture(BASELINE.find(f => f.case_id === id)!, generateCases())), result.baseline);
    write('sensitivity.json', canonicalJson({
      version: VERSION, evidence_kind: 'synthetic_harness_validation', gate_passed: result.gate_passed,
      goldens: result.goldens, regressions: result.regressions, mutants: result.mutants,
      note: 'P1a evaluates fixed synthetic observations. A mutant counts only when it reproduces its pin, replaces exactly one evaluator rule, is detected by verdict or by diagnosis, and no evaluation is a technical failure. A regression entry is pinned for reproducibility and must keep earlier confirmed findings; it is not counted as detection.',
    }) + '\n');
    manifest(out, files, { command: 'self-test', profile_sha256: sha256, corpus_sha256: sha256Hex(corpusBytes()), input_observations_sha256: null });
    console.log(canonicalJson({ gate_passed: result.gate_passed, goldens_ok: result.goldens.every(g => g.ok), regressions_ok: result.regressions.every(r => r.ok), mutants_ok: result.mutants.every(m => m.ok), baseline_exit: result.baseline.report.exit_code }));
    for (const g of result.goldens) if (!g.ok) console.error(`golden mismatch: ${g.name} (${g.detail})`);
    for (const r of result.regressions) if (!r.ok) console.error(`regression mismatch: ${r.id}`);
    for (const m of result.mutants) if (!m.ok) console.error(`mutant mismatch: ${m.id} on ${m.input} (${m.status}, detection ${m.detection})`);
    return result.gate_passed ? 0 : 2;
  }
  if (command === 'evaluate') {
    const o = options(args, ['--observations', '--profile', '--out'], ['--observations', '--profile', '--out']);
    const profileBytes = readFileSync(resolve(o.get('--profile')!));
    const rawObservations = readFileSync(resolve(o.get('--observations')!));
    const observations: unknown = JSON.parse(rawObservations.toString('utf8'));
    const r = evaluateRun(JSON.parse(profileBytes.toString('utf8')), sha256Hex(profileBytes), observations);
    const { out, files, write } = writer(o.get('--out')!);
    bundle(write, '', observations as unknown[], r);
    manifest(out, files, { command: 'evaluate', profile_sha256: sha256Hex(profileBytes), corpus_sha256: sha256Hex(corpusBytes()), input_observations_sha256: sha256Hex(rawObservations) });
    console.log(brief(r.report));
    return r.report.exit_code;
  }
  if (command === 'validate-report') {
    const o = options(args, ['--file'], ['--file']);
    const errors = validateReport(JSON.parse(readFileSync(resolve(o.get('--file')!), 'utf8')));
    for (const e of errors) console.error(e);
    return errors.length ? 2 : 0;
  }
  if (command === 'oracle-boundary') {
    options(args, [], []);
    const r = checkExternalActionsOracleBoundary(root);
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 2;
  }
  if (command === 'write-goldens') {
    options(args, [], []);
    const cases = generateCases();
    const put = (path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
    put(PATHS.corpus, corpusBytes(cases));
    put(PATHS.corpusSha, sha256Hex(corpusBytes(cases)) + '\n');
    for (const f of ALL_FIXTURES) put(`${PATHS.fixtures}/${f.id}.json`, fixtureBytes(buildFixture(f, cases)));
    const { profile } = loadProfile(root);
    put(PATHS.baselineObservations, canonicalJson(profile.cases.map(id => buildFixture(BASELINE.find(f => f.case_id === id)!, cases))) + '\n');
    return 0;
  }
  if (command === 'compute-pins') {
    options(args, [], []);
    const { profile } = loadProfile(root);
    const regressions = REGRESSIONS.map(rv => { const r = runRegression(profile, rv); return { id: rv.id, input: rv.input, case_id: r.caseId, run_exit: r.run_exit, result: r.pin }; });
    const mutants = ADAPTER_MUTANTS.flatMap(m => MUTANT_INPUTS[m.id].map(input => { const r = runMutant(profile, m.id, input); return { id: m.id, input, rule: m.rule, patched: m.patched, kept: m.kept, detection: r.detection, correct: r.correct, mutant: r.mutant }; }));
    console.log(JSON.stringify({ regressions, mutants }, null, 2));
    return 0;
  }
  throw new Error(USAGE);
}

(async () => {
  try {
    const cmd = process.argv[2];
    const r = cmd?.startsWith('p1b-') ? await p1b(cmd, process.argv.slice(3)) : null;
    process.exitCode = r ?? main(cmd, process.argv.slice(3));
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
})();
