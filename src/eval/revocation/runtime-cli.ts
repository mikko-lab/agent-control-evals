/**
 * Declared-profile commands of the revocation CLI (revocation-0.4.0):
 *
 *   run-adapter --lock FILE --profile FILE --out DIR [--work DIR] [--sut-source PATH] [--verify-baseline]
 *   mutants     --lock FILE --profile FILE --out DIR [--work DIR] [--sut-source PATH] [--only M1,M2,...]
 *   evaluate    --observations FILE --lock FILE --profile FILE --out DIR
 *     (recorded corpus and supplement observations of a run-adapter bundle; the SUT is not started)
 *
 * Both fail closed on the lock, the committed profile and supplement (golden SHA-256 and classifier), and the golden
 * corpus before any runtime is invoked. Exit codes: run-adapter as profileExitCode (2/1/3, never 0); mutants 0 when
 * every SUT and adapter mutant is detected by its fixed witness, 1 when one survives, 2 on a technical failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, canonicalJsonLines } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { generateCorpus } from '../../corpus/revocation/cases';
import { expected } from '../../oracle/revocation/expected';
import { Case, Evidence, Expected, VERSION } from '../../spec/revocation/model';
import { evaluate } from './evaluate';
import { loadRevocationLock, RevocationLock } from '../../sut/revocation-lock';
import { prepareRevocationEnv, RevocationEnv } from '../../sut/revocation-env';
import { controlSteps, loadProfile, loadSupplement, Profile, Supplement, SupplementCase } from '../../profile/revocation/profile';
import { buildProfileReport, ObservationSource, profileExitCode, profileSummary, ProfileReport } from '../../report/revocation/profile-report';
import { validateProfileReport } from '../../report/revocation/validate';
import { observationsOf, runProfile } from './runtime-run';
import { MUTANTS, witnessFailures } from '../../mutation/revocation/mutants';
import { adapterMutantChecks } from '../../mutation/revocation/adapter-mutants';

const IMPLEMENTATION = [
  'dist/src/revocation-cli.js', 'dist/src/eval/revocation/runtime-cli.js', 'dist/src/eval/revocation/runtime-run.js', 'dist/src/eval/revocation/evaluate.js',
  'dist/src/spec/revocation/model.js', 'dist/src/spec/revocation/runtime-observation.js',
  'dist/src/corpus/revocation/cases.js', 'dist/src/corpus/revocation/design.js', 'dist/src/oracle/revocation/expected.js',
  'dist/src/profile/revocation/classifier.js', 'dist/src/profile/revocation/profile.js',
  'dist/src/adapter/revocation-runtime/runner.js', 'dist/src/adapter/revocation-runtime/sut.js',
  'dist/src/report/revocation/report.js', 'dist/src/report/revocation/profile-report.js', 'dist/src/report/revocation/validate.js',
  'dist/src/sut/checkout.js', 'dist/src/sut/revocation-lock.js', 'dist/src/sut/revocation-env.js',
  'dist/src/mutation/revocation/mutants.js', 'dist/src/mutation/revocation/adapter-mutants.js',
  'dist/src/util/canonical-json.js', 'dist/src/util/hash.js',
  'dist/schemas/revocation/observation.schema.json', 'dist/schemas/revocation/runtime-observation.schema.json',
  'dist/schemas/revocation/report.schema.json', 'dist/schemas/revocation/profile-report.schema.json',
  'package-lock.json',
];

interface Setup {
  root: string; out: string; work: string; sourceOverride?: string;
  lock: RevocationLock; lockPath: string; lockSha256: string;
  cases: Case[]; truths: Expected[]; corpus: string; corpusSha256: string;
  profile: Profile; profilePath: string; profileSha256: string;
  supplement: Supplement; supplementSha256: string;
  flags: Set<string>; options: Map<string, string>;
}

function parse(args: string[], valued: string[], flags: string[]): { options: Map<string, string>; flags: Set<string> } {
  const options = new Map<string, string>();
  const set = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flags.includes(key)) { if (set.has(key)) throw new Error('Invalid or duplicate option'); set.add(key); continue; }
    const value = args[i + 1];
    if (!valued.includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error('Invalid or duplicate option');
    options.set(key, value); i++;
  }
  for (const k of ['--out', '--lock', '--profile']) if (!options.has(k)) throw new Error('Required option missing');
  return { options, flags: set };
}

function setup(command: string, args: string[]): Setup {
  const valued = command === 'evaluate' ? ['--out', '--lock', '--profile', '--observations'] : ['--out', '--lock', '--profile', '--work', '--sut-source', ...(command === 'mutants' ? ['--only'] : [])];
  const { options, flags } = parse(args, valued, command === 'run-adapter' ? ['--verify-baseline'] : []);
  if (command === 'evaluate' && !options.has('--observations')) throw new Error('Required option missing');
  const root = resolve(__dirname, '..', '..', '..', '..');
  const lockPath = resolve(options.get('--lock')!);
  const { lock, sha256: lockSha256 } = loadRevocationLock(lockPath, VERSION);
  const profilePath = options.get('--profile')!;
  if (resolve(profilePath) !== resolve(root, lock.profile)) throw new Error(`--profile ${profilePath} is not the profile bound by the lock (${lock.profile})`);
  const cases = generateCorpus();
  const corpus = canonicalJsonLines(cases), corpusSha256 = sha256Hex(corpus);
  if (readFileSync(join(root, 'corpus/revocation/smoke.jsonl'), 'utf8') !== corpus || readFileSync(join(root, 'corpus/revocation/smoke.sha256'), 'utf8').trim() !== corpusSha256) throw new Error('Revocation corpus golden mismatch');
  // Applicability and every expectation are fixed before any runtime is invoked.
  const truths = cases.map(expected);
  const { profile, sha256: profileSha256 } = loadProfile(root, lock.profile, cases, corpusSha256, VERSION, lock.sut_commit);
  const { supplement, sha256: supplementSha256 } = loadSupplement(root, lock.supplement, VERSION, lock.sut_commit);
  return {
    root, out: resolve(options.get('--out')!), work: resolve(options.get('--work') ?? join(root, '.work', 'revocation')), sourceOverride: options.get('--sut-source'),
    lock, lockPath, lockSha256, cases, truths, corpus, corpusSha256, profile, profilePath: lock.profile, profileSha256, supplement, supplementSha256, flags, options,
  };
}

function harnessCommit(root: string): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
/** Whether the harness worktree has no tracked or untracked changes (out/, .work/ and dist/ are ignored by git). */
function harnessClean(root: string): boolean {
  try { return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === ''; } catch { return false; }
}

export interface RecordedObservations { corpus: unknown[]; supplement: unknown[] }
export class RecordedInputError extends Error {}

/**
 * The single evaluation path of declared-profile observations, shared by run-adapter (fresh observations) and
 * evaluate (recorded observations): exactly one observation per IN_PROFILE corpus case and per supplement case, no
 * observation for an OUT_OF_SCOPE or unknown case, each evaluated in probe_seq mode with its harness control steps.
 */
export function evaluateRecorded(s: Pick<Setup, 'cases' | 'truths' | 'profile' | 'supplement'>, input: unknown): { evidence: Map<string, Evidence>; supplement: { c: SupplementCase; e: Evidence }[]; observations: RecordedObservations } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RecordedInputError('Recorded observations must be an object with corpus and supplement arrays');
  const keys = Object.keys(input).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['corpus', 'supplement'])) throw new RecordedInputError(`Recorded observations must have exactly the fields corpus and supplement, not ${JSON.stringify(keys)}`);
  const o = input as RecordedObservations;
  if (!Array.isArray(o.corpus) || !Array.isArray(o.supplement)) throw new RecordedInputError('corpus and supplement must be arrays');
  const ids = (list: unknown[], what: string) => list.map((x, i) => {
    const id = typeof x === 'object' && x !== null ? (x as { case_id?: unknown }).case_id : undefined;
    if (typeof id !== 'string') throw new RecordedInputError(`${what}[${i}] has no case_id`);
    return id;
  });
  const corpusIds = ids(o.corpus, 'corpus'), supplementIds = ids(o.supplement, 'supplement');
  const inProfile = s.profile.cases.filter(c => c.applicability === 'IN_PROFILE').map(c => c.id);
  const outOfScope = new Set(s.profile.cases.filter(c => c.applicability === 'OUT_OF_SCOPE').map(c => c.id));
  for (const id of corpusIds) if (outOfScope.has(id)) throw new RecordedInputError(`An observation for the OUT_OF_SCOPE case ${id} is not accepted`);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every(x => a.includes(x));
  if (!sameSet(corpusIds, inProfile)) throw new RecordedInputError('Expected exactly one corpus observation per IN_PROFILE case');
  if (!sameSet(supplementIds, s.supplement.cases.map(c => c.id))) throw new RecordedInputError('Expected exactly one observation per supplement case');
  const evidence = new Map<string, Evidence>();
  s.cases.forEach((c, i) => {
    const p = s.profile.cases[i];
    if (p.applicability !== 'IN_PROFILE') return;
    evidence.set(c.id, evaluate(c, s.truths[i], o.corpus[corpusIds.indexOf(c.id)], { ordering: 'probe_seq', controlSteps: p.not_assessed_requirements }));
  });
  const supplement = s.supplement.cases.map(sc => {
    const c: Case = { id: sc.id, family: sc.family, authorities: sc.authorities, steps: sc.steps };
    return { c: sc, e: evaluate(c, sc.expected, o.supplement[supplementIds.indexOf(sc.id)], { ordering: 'probe_seq', controlSteps: controlSteps(sc) }) };
  });
  // Canonical order: profile case order, then supplement order.
  const observations = { corpus: inProfile.map(id => o.corpus[corpusIds.indexOf(id)]), supplement: s.supplement.cases.map(c => o.supplement[supplementIds.indexOf(c.id)]) };
  return { evidence, supplement, observations };
}

type Build = { build_sha256: string | null; baseline_verified: boolean };
function reportOf(s: Setup, build: Build, evaluated: ReturnType<typeof evaluateRecorded>, source: ObservationSource): ProfileReport {
  return buildProfileReport({
    corpus: s.cases, truths: s.truths, corpus_sha256: s.corpusSha256, observation_source: source,
    profile: s.profile, profile_sha256: s.profileSha256, supplement_id: s.supplement.supplement, supplement_sha256: s.supplementSha256,
    evidence: evaluated.evidence, supplement: evaluated.supplement,
    sut: { repository: s.lock.sut_repository, commit: s.lock.sut_commit, tree: s.lock.sut_tree, version: s.lock.sut_version, lock_sha256: s.lockSha256, build_sha256: build.build_sha256, baseline_verified: build.baseline_verified },
    harness_commit: harnessCommit(s.root), harness_worktree_clean: harnessClean(s.root),
  });
}

function writer(out: string) {
  mkdirSync(dirname(out), { recursive: true });
  // A fresh directory prevents old reports from becoming apparent evidence of this run.
  mkdirSync(out);
  const files: { path: string; sha256: string }[] = [];
  const write = (path: string, content: string) => { mkdirSync(resolve(out, path, '..'), { recursive: true }); writeFileSync(join(out, path), content); files.push({ path, sha256: sha256Hex(content) }); };
  return { files, write };
}

function bundle(write: (p: string, c: string) => void, prefix: string, observations: RecordedObservations, report: ProfileReport) {
  const errors = validateProfileReport(report);
  if (errors.length) throw new Error(`profile report schema: ${errors.join('; ')}`);
  write(`${prefix}observations.json`, canonicalJson(observations) + '\n');
  write(`${prefix}evidence.jsonl`, canonicalJsonLines(report.evidence));
  write(`${prefix}supplement-evidence.jsonl`, canonicalJsonLines(report.supplement.cases));
  write(`${prefix}report.json`, canonicalJson(report) + '\n');
  write(`${prefix}summary.md`, profileSummary(report));
}

function manifest(s: Setup, env: RevocationEnv | null, files: { path: string; sha256: string }[], extra: Record<string, unknown> = {}, source: ObservationSource = 'pinned_runtime_adapter') {
  const implementation = IMPLEMENTATION.map(path => ({ path, sha256: sha256Hex(readFileSync(join(s.root, path))) }));
  const bound = [s.profilePath, s.profilePath.replace(/\.json$/, '.sha256'), s.lock.supplement, s.lock.supplement.replace(/\.json$/, '.sha256')].map(path => ({ path, sha256: sha256Hex(readFileSync(join(s.root, path))) }));
  return canonicalJson({
    version: VERSION, mode: 'declared_profile', observation_source: source, corpus_sha256: s.corpusSha256,
    lock: { path: 'sut.revocation.lock.json', sha256: s.lockSha256 }, profile: { id: s.profile.profile, sha256: s.profileSha256 }, supplement: { id: s.supplement.supplement, sha256: s.supplementSha256 },
    sut: { repository: s.lock.sut_repository, commit: s.lock.sut_commit, tree: s.lock.sut_tree, version: s.lock.sut_version, build_sha256: env?.build_sha256 ?? null, modules: env?.modules ?? [], baseline_verified: env?.baseline_verified ?? false },
    bound_files: bound, implementation_sha256: sha256Hex(canonicalJson(implementation)), implementation, files, ...extra,
  }) + '\n';
}

async function runAdapter(args: string[]): Promise<number> {
  const s = setup('run-adapter', args);
  const env = prepareRevocationEnv(s.lock, 'baseline', { workDir: s.work, harnessRoot: s.root, sourceOverride: s.sourceOverride, verifyBaseline: s.flags.has('--verify-baseline') });
  const run = await runProfile(env.build, s.cases, s.truths, s.profile, s.supplement);
  // Fresh observations go through exactly the path recorded observations take.
  const evaluated = evaluateRecorded(s, observationsOf(run));
  const report = reportOf(s, env, evaluated, 'pinned_runtime_adapter');
  const { files, write } = writer(s.out);
  write('corpus.jsonl', s.corpus);
  bundle(write, '', evaluated.observations, report);
  writeFileSync(join(s.out, 'manifest.json'), manifest(s, env, files));
  const exit = profileExitCode(report);
  console.log(canonicalJson({ ...report.counts, technically_valid: report.technically_valid, has_confirmed_violation: report.has_confirmed_violation, contract_acceptance_passed: report.contract_acceptance_passed, profile_acceptance_passed: report.profile_acceptance_passed, supplement_acceptance_passed: report.supplement_acceptance_passed, exit }));
  return exit;
}

async function mutants(args: string[]): Promise<number> {
  const s = setup('mutants', args);
  const only = s.options.get('--only')?.split(',');
  const selected = MUTANTS.filter(m => !only || only.includes(m.id));
  if (only && selected.length !== only.length) throw new Error('--only names an unknown mutant');
  const { files, write } = writer(s.out);
  const baseline = prepareRevocationEnv(s.lock, 'baseline', { workDir: s.work, harnessRoot: s.root, sourceOverride: s.sourceOverride });
  const baseRun = await runProfile(baseline.build, s.cases, s.truths, s.profile, s.supplement);
  const baseEvaluated = evaluateRecorded(s, observationsOf(baseRun));
  const baseReport = reportOf(s, baseline, baseEvaluated, 'pinned_runtime_adapter');
  const baseExit = profileExitCode(baseReport);
  bundle(write, 'baseline/', baseEvaluated.observations, baseReport);
  const results: Record<string, unknown>[] = [];
  const builds: { baseline: string; m10?: string; m11?: string } = { baseline: baseline.build };
  for (const m of selected) {
    const env = prepareRevocationEnv(s.lock, m.id, { workDir: s.work, harnessRoot: s.root, sourceOverride: s.sourceOverride, patch: { file: join(s.root, 'mutations/revocation', m.patch), target: m.target } });
    if (m.id === 'M10') builds.m10 = env.build;
    if (m.id === 'M11') builds.m11 = env.build;
    const run = await runProfile(env.build, s.cases, s.truths, s.profile, s.supplement);
    const evaluated = evaluateRecorded(s, observationsOf(run));
    const report = reportOf(s, env, evaluated, 'pinned_runtime_adapter');
    const exit = profileExitCode(report);
    bundle(write, `mutants/${m.id}/`, evaluated.observations, report);
    const e = m.witness.set === 'corpus' ? evaluated.evidence.get(m.witness.case_id) : evaluated.supplement.find(x => x.c.id === m.witness.case_id)?.e;
    const failures = witnessFailures(m.witness, e, exit);
    results.push({ id: m.id, description: m.description, patch: m.patch, patch_sha256: sha256Hex(readFileSync(join(s.root, 'mutations/revocation', m.patch))), typechecked: true, build_sha256: env.build_sha256, witness: m.witness, exit, verdict: e?.verdict ?? null, decision_findings: e?.decision_findings ?? [], effect_findings: e?.effect_findings ?? [], incomplete: e?.incomplete ?? [], detected: failures.length === 0, failures });
  }
  const adapter = only ? [] : await adapterMutantChecks(builds, s.cases, s.truths, s.profile, s.supplement);
  const gate = baseExit === 3 && results.every(r => r.detected) && adapter.every(a => a.detected);
  write('mutants.json', canonicalJson({ version: VERSION, baseline: { exit: baseExit, counts: baseReport.counts, supplement_acceptance_passed: baseReport.supplement_acceptance_passed }, sut_mutants: results, adapter_mutants: adapter, gate_passed: gate, note: 'Witnesses are fixed before the run (src/mutation/revocation/mutants.ts). A mutant patch that does not apply or typecheck aborts the gate as a technical failure; it is never counted as a kill.' }) + '\n');
  writeFileSync(join(s.out, 'manifest.json'), manifest(s, baseline, files, { mutant_patches: MUTANTS.map(m => ({ id: m.id, patch: m.patch, sha256: sha256Hex(readFileSync(join(s.root, 'mutations/revocation', m.patch))) })) }));
  console.log(canonicalJson({ baseline_exit: baseExit, sut_mutants: results.map(r => ({ id: r.id, detected: r.detected, exit: r.exit })), adapter_mutants: adapter.map(a => ({ id: a.id, detected: a.detected })), gate_passed: gate }));
  return gate ? 0 : 1;
}

/** Evaluates recorded observations without starting the SUT: same validations, evaluation and exit rules. */
async function evaluateCommand(args: string[]): Promise<number> {
  const s = setup('evaluate', args);
  const raw = readFileSync(resolve(s.options.get('--observations')!));
  let input: unknown;
  try { input = JSON.parse(raw.toString('utf8')); } catch { throw new RecordedInputError('Recorded observations are not valid JSON'); }
  const evaluated = evaluateRecorded(s, input);
  const source: ObservationSource = 'recorded_runtime_adapter_observations';
  const report = reportOf(s, { build_sha256: null, baseline_verified: false }, evaluated, source);
  const { files, write } = writer(s.out);
  write('corpus.jsonl', s.corpus);
  bundle(write, '', evaluated.observations, report);
  writeFileSync(join(s.out, 'manifest.json'), manifest(s, null, files, { input_observations_sha256: sha256Hex(raw) }, source));
  const exit = profileExitCode(report);
  console.log(canonicalJson({ ...report.counts, technically_valid: report.technically_valid, has_confirmed_violation: report.has_confirmed_violation, contract_acceptance_passed: report.contract_acceptance_passed, profile_acceptance_passed: report.profile_acceptance_passed, supplement_acceptance_passed: report.supplement_acceptance_passed, exit }));
  return exit;
}

export async function runtimeCommand(command: string, args: string[]): Promise<number> {
  return command === 'run-adapter' ? runAdapter(args) : command === 'evaluate' ? evaluateCommand(args) : mutants(args);
}
