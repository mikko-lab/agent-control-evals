/**
 * Regressions of the eval mutant gate's own classification (mutations/revocation/gate-regressions.json, golden SHA-256
 * in gate-regressions.sha256). Each case runs `mutants --only <mutant>` against the real pinned runtime, optionally with
 * edits to that mutant run's observations (`--inject`), and requires the case's gate exit, the mutant's outcome and,
 * for a rejection, the reason the gate reports.
 *
 * Usage: node dist/scripts/mutant-gate-regressions.js [--lock FILE] [--work DIR] [--only G1,G2] [--out FILE]
 * Exit: 0 every case as required; 1 a case gives another gate result; 2 technical failure of this script (golden
 * mismatch, a gate that wrote no result, a crash).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

interface RegressionCase { id: string; mutant: string; injections: unknown[]; expected_exit: number; expected_outcome: string; expected_reason?: string; why: string }

export function main(argv: string[]): number {
  const root = resolve(__dirname, '..', '..');
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const file = join(root, 'mutations/revocation/gate-regressions.json');
  const raw = readFileSync(file);
  const golden = readFileSync(file.replace(/\.json$/, '.sha256'), 'utf8').trim();
  const sha = createHash('sha256').update(raw).digest('hex');
  if (sha !== golden) { console.error(`gate regressions: ${file} SHA-256 ${sha} != golden ${golden}`); return 2; }
  const spec = JSON.parse(raw.toString('utf8')) as { regressions: string; cases: RegressionCase[] };
  const only = opt('--only')?.split(',');
  const cases = spec.cases.filter(c => !only || only.includes(c.id));
  if (only && cases.length !== only.length) { console.error('gate regressions: --only names an unknown case'); return 2; }
  const lockPath = resolve(opt('--lock') ?? join(root, 'sut.revocation.lock.json'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { profile: string };
  const work = mkdtempSync(join(tmpdir(), 'mutant-gate-regressions-'));
  const results: Record<string, unknown>[] = [];
  let failed = 0, technical = 0;
  try {
    for (const c of cases) {
      const args = [join(root, 'dist/src/revocation-cli.js'), 'mutants', '--lock', lockPath, '--profile', join(root, lock.profile), '--only', c.mutant, '--out', join(work, c.id)];
      if (opt('--work')) args.push('--work', resolve(opt('--work')!));
      if (c.injections.length) {
        const inject = join(work, `${c.id}.inject.json`);
        writeFileSync(inject, JSON.stringify({ mutant: c.mutant, injections: c.injections }));
        args.push('--inject', inject);
      }
      const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
      let gate: { sut_mutants?: { id: string; outcome: string; failures?: string[]; technical?: string[] }[] } | null = null;
      try { gate = JSON.parse(readFileSync(join(work, c.id, 'mutants.json'), 'utf8')); } catch { gate = null; }
      const m = gate?.sut_mutants?.find(x => x.id === c.mutant);
      if (!m) {
        technical++;
        results.push({ id: c.id, ok: false, technical: true, exit: r.status, signal: r.signal, stderr: (r.stderr ?? '').slice(-2000) });
        console.log(`TECH ${c.id}: gate exit ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}, no mutant result`);
        continue;
      }
      const reasons = [...(m.technical ?? []), ...(m.failures ?? [])].join(' | ');
      const ok = r.status === c.expected_exit && !r.signal && m.outcome === c.expected_outcome && (!c.expected_reason || reasons.includes(c.expected_reason));
      if (!ok) failed++;
      results.push({ id: c.id, mutant: c.mutant, ok, exit: r.status, expected_exit: c.expected_exit, outcome: m.outcome, expected_outcome: c.expected_outcome, expected_reason: c.expected_reason ?? null, reasons });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id}: gate exit ${r.status}, outcome ${m.outcome}; expected exit ${c.expected_exit}, ${c.expected_outcome}${c.expected_reason ? ` with "${c.expected_reason}"` : ''} | ${reasons.slice(0, 300)}`);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const report = { regressions: spec.regressions, sha256: sha, cases: results, passed: failed === 0 && technical === 0 };
  if (opt('--out')) writeFileSync(resolve(opt('--out')!), JSON.stringify(report, null, 2) + '\n');
  return technical ? 2 : failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
