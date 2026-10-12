/**
 * Runtime-own test evidence of the pinned revocation SUT (coverage expansion plan, sections 7.2 and 7.8):
 *
 *   runtime-gates --lock FILE --out DIR [--work DIR] [--sut-source PATH]
 *                 [--gates tenant,ancestor,regressions,lifecycle,lifecycle_regressions,lifecycle_determinism]
 *
 * Runs the pinned runtime's own mutant gates (tenant, ancestor and, for a permit-mode pin, lifecycle), the tenant
 * gate's regressions R1-R4 and, for a permit-mode pin, the lifecycle gate's regressions RL1-RL24 and its witness
 * determinism check inside a fresh, verified checkout of the locked commit, and compares them with the lock's
 * runtime_test_gates: the gate manifests' SHA-256 before and after the run, each gate's exit, the detected mutants per
 * evidence kind (the lifecycle gate's lifecycle and availability kinds are their own labels, never containment), the
 * lifecycle gate's counts, variants and entries with labels beyond their kind, the recorded coverage gaps, and each
 * regression case's exit. This is runtime-own evidence only: it never counts as corpus or supplement evidence and is
 * reported apart from the eval's mutant gate. --gates runs a subset (every pinned gate by default); the report names
 * the gates that were run and passes only for those.
 *
 * Exit: 0 when everything matches the lock; 1 when a runtime gate reports a mutant it did not detect or a regression
 * case gives another gate exit; 2 on any technical failure (checkout, install, process error, signal, timeout, a
 * missing or unreadable report, a changed manifest, a technical failure inside a runtime gate, or evidence that
 * differs from the lock).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { VERSION } from '../../spec/revocation/model';
import { GATE_KINDS, GateKind, LIFECYCLE_GATE_KINDS, loadRevocationLock, RuntimeGateRegressions, RuntimeTestGate } from '../../sut/revocation-lock';
import { prepareRevocationEnv } from '../../sut/revocation-env';

const GATE_TIMEOUT_MS = 120 * 60_000;

interface GateOutcome { status: 'match' | 'not_detected' | 'technical_failure'; issues: string[]; [k: string]: unknown }

function parse(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (!['--lock', '--out', '--work', '--sut-source', '--gates'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error('Invalid or duplicate option');
    options.set(key, value);
  }
  for (const k of ['--lock', '--out']) if (!options.has(k)) throw new Error('Required option missing');
  return options;
}

/** Runs one npm script of the checkout; returns a technical issue, or undefined and the process result. */
function npmRun(dir: string, command: string) {
  const script = /^npm run ([a-z:-]+)$/.exec(command)?.[1];
  if (!script) return { issue: `unsupported gate command ${JSON.stringify(command)}` };
  const p = spawnSync('npm', ['run', '--silent', script], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28, timeout: GATE_TIMEOUT_MS });
  if (p.error) return { issue: `${command}: ${(p.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timed out' : p.error.message}` };
  if (p.signal) return { issue: `${command}: killed by signal ${p.signal}` };
  return { status: p.status as number, output: (p.stdout ?? '') + (p.stderr ?? '') };
}

const sorted = (xs: string[]) => [...xs].sort();
function checkGate(name: string, gate: RuntimeTestGate, dir: string): GateOutcome {
  const KINDS: readonly GateKind[] = name === 'lifecycle' ? LIFECYCLE_GATE_KINDS : GATE_KINDS;
  const manifestSha = () => sha256Hex(readFileSync(join(dir, gate.manifest)));
  if (manifestSha() !== gate.manifest_sha256) return { status: 'technical_failure', issues: [`${gate.manifest} SHA-256 differs from the lock before the run`] };
  const r = npmRun(dir, gate.command);
  if ('issue' in r) return { status: 'technical_failure', issues: [r.issue!] };
  const issues: string[] = [];
  if (manifestSha() !== gate.manifest_sha256) issues.push(`${gate.manifest} changed during the run`);
  const reportPath = join(dir, gate.report);
  if (!existsSync(reportPath)) return { status: 'technical_failure', issues: [...issues, `${gate.report} missing (gate exit ${r.status})`], exit: r.status };
  let report: { manifest_sha256?: string; control?: unknown; summary?: { detected: number; not_detected: number; technical_failures: number; evidence: Record<string, string[]>; recorded_gaps: string[]; counts?: Record<string, number>; variants?: Record<string, string[]>; observed_beyond_kind?: Record<string, unknown> }; mutants?: { id: string; kind: string; status: string }[] };
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return { status: 'technical_failure', issues: [...issues, `${gate.report} is not JSON`], exit: r.status }; }
  const sum = report.summary;
  if (!sum || !Array.isArray(report.mutants)) return { status: 'technical_failure', issues: [...issues, `${gate.report} has no summary`], exit: r.status };
  if (report.manifest_sha256 !== gate.manifest_sha256) issues.push(`report manifest SHA-256 ${report.manifest_sha256} != lock`);
  if (r.status === 2 || sum.technical_failures !== 0) issues.push(`runtime gate reports ${sum.technical_failures} technical failures (exit ${r.status})`);
  for (const k of KINDS) if (canonicalJson(sorted(sum.evidence?.[k] ?? [])) !== canonicalJson(sorted(gate.evidence[k] ?? []))) issues.push(`${k} evidence ${JSON.stringify(sum.evidence?.[k] ?? null)} != lock ${JSON.stringify(gate.evidence[k])}`);
  if (canonicalJson(sum.recorded_gaps ?? null) !== canonicalJson(gate.recorded_gaps)) issues.push(`recorded gaps ${JSON.stringify(sum.recorded_gaps ?? null)} != lock ${JSON.stringify(gate.recorded_gaps)}`);
  const evidenceKeys = Object.keys(sum.evidence ?? {}).sort();
  if (canonicalJson(evidenceKeys) !== canonicalJson([...KINDS].sort())) issues.push(`report evidence kinds ${JSON.stringify(evidenceKeys)} != ${JSON.stringify([...KINDS].sort())}`);
  if (name === 'lifecycle') {
    if (canonicalJson(sum.counts ?? null) !== canonicalJson(gate.counts ?? null)) issues.push(`counts ${JSON.stringify(sum.counts ?? null)} != lock ${JSON.stringify(gate.counts ?? null)}`);
    if (canonicalJson(sum.variants ?? null) !== canonicalJson(gate.variants ?? null)) issues.push(`variants ${JSON.stringify(sum.variants ?? null)} != lock ${JSON.stringify(gate.variants ?? null)}`);
    const beyond = Object.keys(sum.observed_beyond_kind ?? {}).sort();
    if (canonicalJson(beyond) !== canonicalJson([...(gate.observed_beyond_kind ?? [])].sort())) issues.push(`observed_beyond_kind ${JSON.stringify(beyond)} != lock ${JSON.stringify(gate.observed_beyond_kind ?? null)}`);
  }
  const notDetected = report.mutants.filter(m => m.status === 'not_detected').map(m => m.id);
  const status = issues.length ? 'technical_failure' : r.status === 1 || notDetected.length ? 'not_detected' : r.status !== gate.expected_exit ? 'technical_failure' : 'match';
  if (status === 'technical_failure' && !issues.length) issues.push(`gate exit ${r.status} != expected ${gate.expected_exit}`);
  if (status === 'not_detected') issues.push(`not detected: ${notDetected.join(', ') || `(gate exit ${r.status})`}`);
  return {
    status, issues, gate: name, command: gate.command, exit: r.status, expected_exit: gate.expected_exit,
    manifest: { path: gate.manifest, sha256: gate.manifest_sha256 }, report: { path: gate.report, sha256: sha256Hex(readFileSync(reportPath)) },
    control: report.control, detected: sum.detected, not_detected: sum.not_detected, technical_failures: sum.technical_failures,
    evidence: Object.fromEntries(KINDS.map(k => [k, sum.evidence?.[k] ?? []])),
    // Reported apart, never merged: containment (a tool runs or managed state changes), lifecycle (approval, permit or
    // lineage state only), availability (an allowed action denied), check point only (production path), component only.
    containment_evidence: [...(sum.evidence?.both ?? []), ...(sum.evidence?.containment_effect ?? [])],
    lifecycle_evidence: [...(sum.evidence?.lifecycle_effect ?? []), ...(sum.evidence?.check_and_lifecycle ?? [])],
    availability_evidence: [...(sum.evidence?.availability_effect ?? []), ...(sum.evidence?.check_and_availability ?? [])],
    check_point_only: sum.evidence?.check_point ?? [],
    check_point_evidence_production_path: [...(sum.evidence?.both ?? []), ...(sum.evidence?.check_point ?? []), ...(sum.evidence?.check_and_lifecycle ?? []), ...(sum.evidence?.check_and_availability ?? [])],
    component_evidence_only: sum.evidence?.component_check_point ?? [],
    ...(name === 'lifecycle' ? { counts: sum.counts, variants: sum.variants, observed_beyond_kind: sum.observed_beyond_kind } : {}),
    recorded_gaps: sum.recorded_gaps,
  };
}

/** Runs a gate-regression script and compares each case's gate exit with the lock (an R or RL case id). */
function checkRegressions(dir: string, pinned: RuntimeGateRegressions): GateOutcome {
  const reg = npmRun(dir, pinned.command);
  const out: GateOutcome = { status: 'match', issues: [], command: pinned.command, expected_exit: pinned.expected_exit };
  if ('issue' in reg) return { ...out, status: 'technical_failure', issues: [reg.issue!] };
  const cases: Record<string, { gate_exit: number | null; ok: boolean; line: string }> = {};
  for (const [id, want] of Object.entries(pinned.cases)) {
    const line = reg.output!.split('\n').find(l => / ([A-Z]+\d+-[a-z0-9-]+): gate exit /.exec(l)?.[1] === id) ?? '';
    const exit = /: gate exit (\d+)/.exec(line);
    cases[id] = { gate_exit: exit ? Number(exit[1]) : null, ok: line.startsWith('ok ') && !!exit && Number(exit[1]) === want, line: line.slice(0, 300) };
    if (!exit) out.issues.push(`${id}: no result line`);
    else if (!cases[id].ok) out.issues.push(`${id}: gate exit ${exit[1]}, expected ${want}${line.startsWith('ok ') ? '' : ' (FAIL)'}`);
  }
  const extra = reg.output!.split('\n').map(l => / ([A-Z]+\d+-[a-z0-9-]+): gate exit /.exec(l)?.[1]).filter((x): x is string => !!x && !(x in pinned.cases));
  for (const id of extra) out.issues.push(`${id}: a regression case the lock does not pin`);
  Object.assign(out, { exit: reg.status, cases });
  if (out.issues.some(x => x.endsWith('no result line') || x.endsWith('does not pin'))) out.status = 'technical_failure';
  else if (out.issues.length || reg.status !== pinned.expected_exit) {
    out.status = 'not_detected';
    if (!out.issues.length) out.issues.push(`exit ${reg.status} != expected ${pinned.expected_exit}`);
  }
  return out;
}

export async function runtimeGates(args: string[]): Promise<number> {
  const options = parse(args);
  const root = resolve(__dirname, '..', '..', '..', '..');
  const lockPath = resolve(options.get('--lock')!);
  const { lock, sha256: lockSha256 } = loadRevocationLock(lockPath, VERSION);
  const gates = lock.runtime_test_gates;
  if (!gates) throw new Error(`${lockPath} pins no runtime_test_gates`);
  const pinned = ['tenant', 'ancestor', 'regressions', ...(gates.lifecycle ? ['lifecycle', 'lifecycle_regressions', 'lifecycle_determinism'] : [])];
  const selected = (options.get('--gates') ?? pinned.join(',')).split(',');
  if (!selected.length || selected.some(g => !pinned.includes(g)) || new Set(selected).size !== selected.length) throw new Error('--gates names an unknown, unpinned or duplicate gate');
  const out = resolve(options.get('--out')!);
  mkdirSync(resolve(out, '..'), { recursive: true });
  mkdirSync(out);
  // A fresh, verified checkout of the locked commit (tag, tree, package-lock, gate manifests), installed with npm ci.
  const env = prepareRevocationEnv(lock, 'runtime-gates', { workDir: resolve(options.get('--work') ?? join(root, '.work', 'revocation')), harnessRoot: root, sourceOverride: options.get('--sut-source') });
  const skipped = (): GateOutcome => ({ status: 'match', issues: [], skipped: true });
  const tenant = selected.includes('tenant') ? checkGate('tenant', gates.tenant, env.checkout) : skipped();
  const ancestor = selected.includes('ancestor') ? checkGate('ancestor', gates.ancestor, env.checkout) : skipped();
  const lifecycle = gates.lifecycle && selected.includes('lifecycle') ? checkGate('lifecycle', gates.lifecycle, env.checkout) : skipped();
  const regressions = selected.includes('regressions') ? checkRegressions(env.checkout, gates.regressions) : skipped();
  const lifecycleRegressions = gates.lifecycle_regressions && selected.includes('lifecycle_regressions') ? checkRegressions(env.checkout, gates.lifecycle_regressions) : skipped();
  let determinism: GateOutcome = skipped();
  if (gates.lifecycle_determinism && selected.includes('lifecycle_determinism')) {
    const d = npmRun(env.checkout, gates.lifecycle_determinism.command);
    if ('issue' in d) determinism = { status: 'technical_failure', issues: [d.issue!] };
    else {
      const lines = d.output!.split('\n').filter(l => /^run \d+: |^witness determinism: /.test(l)).map(l => l.slice(0, 300));
      const ok = d.status === gates.lifecycle_determinism.expected_exit && lines.some(l => /^witness determinism: \d+ identical runs$/.test(l));
      determinism = { status: ok ? 'match' : d.status === 1 ? 'not_detected' : 'technical_failure', issues: ok ? [] : [`exit ${d.status} != expected ${gates.lifecycle_determinism.expected_exit}`], command: gates.lifecycle_determinism.command, exit: d.status, expected_exit: gates.lifecycle_determinism.expected_exit, runs: lines };
    }
  }
  const all = [tenant, ancestor, lifecycle, regressions, lifecycleRegressions, determinism];
  const exit = all.some(g => g.status === 'technical_failure') ? 2 : all.some(g => g.status === 'not_detected') ? 1 : 0;
  const report = {
    version: VERSION, evidence_scope: 'runtime_own_tests',
    note: 'Runtime-own test evidence of the pinned SUT (plan sections 7.2 and 7.8). It is never corpus or supplement evidence and is reported apart from the eval mutant gate (mutants.json). component_check_point evidence is never production-path evidence.',
    lock: { path: relative(root, lockPath).split('\\').join('/'), sha256: lockSha256 },
    sut: { repository: lock.sut_repository, commit: lock.sut_commit, tree: lock.sut_tree, version: lock.sut_version, tag: lock.sut_tag ?? null },
    gates_run: selected, gates: { tenant, ancestor, ...(gates.lifecycle ? { lifecycle } : {}) }, regressions,
    ...(gates.lifecycle ? { lifecycle_regressions: lifecycleRegressions, lifecycle_determinism: determinism } : {}), passed: exit === 0, exit,
  };
  writeFileSync(join(out, 'runtime-gates.json'), canonicalJson(report) + '\n');
  for (const [name, g] of [['tenant', gates.tenant], ['ancestor', gates.ancestor], ...(gates.lifecycle ? [['lifecycle', gates.lifecycle]] : [])] as [string, RuntimeTestGate][]) {
    const p = join(env.checkout, g.report);
    if (existsSync(p)) writeFileSync(join(out, `${name}-report.json`), readFileSync(p));
  }
  const brief = (g: GateOutcome) => ({ status: g.status, detected: g.detected ?? null, issues: g.issues });
  console.log(canonicalJson({ tenant: brief(tenant), ancestor: brief(ancestor), lifecycle: brief(lifecycle), regressions: brief(regressions), lifecycle_regressions: brief(lifecycleRegressions), lifecycle_determinism: brief(determinism), exit }));
  return exit;
}
