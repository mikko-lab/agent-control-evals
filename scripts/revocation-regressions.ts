/**
 * Evaluator self-regression check for revocation-0.2.0. Each mutant is a deliberate evaluator defect applied to a
 * disposable copy of the compiled harness (the production evaluator is never changed). A mutant counts as caught only
 * by content: its patch applies exactly once, the copied suite loads and runs (other tests pass, none cancelled), and
 * the named sentinel tests fail with assertion errors; mutants that remove a gate signal must also fail the
 * sensitivity gate for the named faults while the self-test still completes.
 *
 * Usage: node dist/scripts/revocation-regressions.js [--out FILE]   exit 0 = all caught, 1 = a mutant survived, 2 = technical failure.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface Mutant { id: string; description: string; file: string; from: string; to: string; sentinels: string[]; gate_unkilled: string[] }
const EVALUATOR = 'dist/src/eval/revocation/evaluate.js';
export const MUTANTS: Mutant[] = [
  {
    id: 'drop_decision_findings', description: 'Decision findings are never recorded.', file: EVALUATOR,
    from: 'e.decision_findings.push(', to: 'void (',
    sentinels: ['decision channel: false_allow is reported exactly when ALLOW is recorded where the oracle requires DENY, with effects still correct', 'decision channel: false_deny is reported exactly when DENY is recorded where the oracle requires ALLOW, with effects still correct'],
    gate_unkilled: ['decision_only_false_allow', 'decision_only_false_deny'],
  },
  {
    id: 'step_blind_effects', description: 'Effect comparison ignores the occurrence step.', file: EVALUATOR,
    from: 'return step >= expected.earliest && step <= expected.latest;', to: 'return true;',
    sentinels: ['timing: a commit shifted across the cut is detected from its occurrence step although kind and identity are unchanged', 'timing: exact-step effects are not given a late window (delivery one step late is a violation)'],
    gate_unkilled: ['write_behind_commit'],
  },
  {
    id: 'no_start_terminal_pairing', description: 'Observed starts are no longer paired with a later terminal.', file: EVALUATOR,
    from: 'for (const started of acceptedStarts)', to: 'for (const started of [])',
    sentinels: ['terminal: unauthorized start without terminal evidence is incomplete, so it cannot kill a fault'],
    gate_unkilled: [],
  },
  {
    id: 'ignore_unexpected_terminals', description: 'Unexpected terminal observations are ignored.', file: EVALUATOR,
    from: 'if (match === undefined)', to: "if (match === undefined && f.kind === 'execution_terminal') continue; if (match === undefined)",
    sentinels: ['terminal: a premature terminal outside its window is an effect violation, and the window stays unconfirmed', 'terminal: unauthorized start with later terminal is a valid, complete violation including the unexpected terminal'],
    gate_unkilled: [],
  },
];

interface TestRun { pass: number; fail: number; cancelled: number; failing: Map<string, string>; names: Set<string> }
function runTests(dir: string): TestRun {
  const testDir = join(dir, 'dist/test/revocation');
  const files = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort().map(f => join(testDir, f));
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = r.stdout.split('\n');
  const failing = new Map<string, string>(); const names = new Set<string>();
  const testLine = /^\s*(not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/;
  lines.forEach((line, i) => {
    const m = testLine.exec(line); if (!m) return;
    names.add(m[2]);
    if (m[1]) { let j = i + 1; while (j < lines.length && !testLine.test(lines[j])) j++; failing.set(m[2], lines.slice(i + 1, j).join('\n')); }
  });
  const count = (k: string) => Number(new RegExp(`^# ${k} (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? NaN);
  return { pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), failing, names };
}
function selfTest(dir: string, out: string): { exit: number | null; unkilled: string[] | null } {
  const r = spawnSync(process.execPath, [join(dir, 'dist/src/revocation-cli.js'), 'self-test', '--out', out], { cwd: dir, encoding: 'utf8' });
  const path = join(out, 'sensitivity.json');
  return { exit: r.status, unkilled: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).faults.filter((f: { killed: boolean }) => !f.killed).map((f: { fault: string }) => f.fault) : null };
}
function copy(root: string, work: string, name: string): string {
  const dir = join(work, name);
  cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
  for (const link of ['corpus', 'node_modules', 'package-lock.json', 'package.json', 'schemas', 'scripts', 'src']) symlinkSync(join(root, link), join(dir, link));
  return dir;
}

export function main(argv: string[]): number {
  const root = resolve(__dirname, '..', '..');
  const outIndex = argv.indexOf('--out');
  const work = mkdtempSync(join(tmpdir(), 'revocation-regressions-'));
  const technical: string[] = [];
  try {
    const controlDir = copy(root, work, 'control');
    const control = { tests: runTests(controlDir), self_test: selfTest(controlDir, join(work, 'control-out')) };
    if (control.tests.fail !== 0 || control.tests.cancelled !== 0 || !(control.tests.pass > 0)) technical.push('unmutated control suite does not pass');
    if (control.self_test.exit !== 0) technical.push('unmutated control self-test does not pass');
    const results = MUTANTS.map(m => {
      const dir = copy(root, work, m.id);
      const target = join(dir, m.file);
      const source = readFileSync(target, 'utf8');
      const occurrences = source.split(m.from).length - 1;
      if (occurrences !== 1) { technical.push(`${m.id}: patch anchor found ${occurrences} times`); return { id: m.id, description: m.description, caught: false }; }
      rmSync(target); writeFileSync(target, source.replace(m.from, m.to));
      for (const s of m.sentinels) if (!control.tests.names.has(s)) technical.push(`${m.id}: sentinel test not present in control run: ${s}`);
      const tests = runTests(dir);
      const loaded = tests.pass > 0 && tests.cancelled === 0;
      if (!loaded) technical.push(`${m.id}: mutated suite did not load and run`);
      const sentinel_failures = m.sentinels.map(s => ({ test: s, failed: tests.failing.has(s), assertion: /ERR_ASSERTION/.test(tests.failing.get(s) ?? '') }));
      const st = selfTest(dir, join(work, `${m.id}-out`));
      if (st.unkilled === null) technical.push(`${m.id}: mutated self-test did not complete`);
      const gate = m.gate_unkilled.every(f => st.unkilled?.includes(f)) && (m.gate_unkilled.length === 0 || st.exit === 2);
      const caught = loaded && sentinel_failures.every(s => s.failed && s.assertion) && gate;
      return { id: m.id, description: m.description, caught, tests: { pass: tests.pass, fail: tests.fail, cancelled: tests.cancelled, failing: [...tests.failing.keys()].sort() }, sentinel_failures, self_test_exit: st.exit, gate_unkilled: st.unkilled, gate_expected_unkilled: m.gate_unkilled };
    });
    const report = { control: { pass: control.tests.pass, fail: control.tests.fail, cancelled: control.tests.cancelled, self_test_exit: control.self_test.exit }, mutants: results, technical_errors: technical, all_caught: technical.length === 0 && results.every(r => r.caught) };
    const text = JSON.stringify(report, null, 2) + '\n';
    if (outIndex >= 0 && argv[outIndex + 1]) writeFileSync(resolve(argv[outIndex + 1]), text);
    process.stdout.write(text);
    return technical.length ? 2 : report.all_caught ? 0 : 1;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
