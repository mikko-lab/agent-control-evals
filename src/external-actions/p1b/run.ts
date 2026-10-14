/**
 * P1b run: the environment check, then every profile case against the local doubles with one guard (the reference
 * guard or one XM mutant), then the evaluation. Runs as root; the output directory is handed back to the invoking user.
 */
import { randomBytes } from 'node:crypto';
import { chownSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, canonicalJsonLines } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { generateCases } from '../corpus/cases';
import { reportJson, summary, validateReport } from '../report/report';
import { VERSION } from '../spec/model';
import { canonicalBytes, canonicalCase } from './canonical';
import { loadP1bProfile, loadRunConfig, P1B_PATHS, p1bConfigIssues, planCase } from './config';
import { envCheck, EnvCheck } from './env-check';
import { evaluateP1bRun, P1bResult } from './evaluate-run';
import { Injection, prepareCode, runCase, teardownRun } from './orchestrator';

export const P1B_IMPLEMENTATION = [
  'dist/src/external-actions-cli.js', 'dist/src/external-actions/spec/model.js', 'dist/src/external-actions/corpus/cases.js',
  'dist/src/external-actions/oracle/expected.js', 'dist/src/external-actions/eval/evaluate.js', 'dist/src/external-actions/eval/run.js',
  'dist/src/external-actions/report/report.js', 'dist/src/util/canonical-json.js', 'dist/src/util/hash.js',
  ...['canonical', 'case-runner', 'canary', 'config', 'doubles', 'env-check', 'evaluate-run', 'executor', 'forwarder', 'gate', 'netem-reader', 'orchestrator', 'patch', 'probe', 'record', 'regressions', 'run', 'validity'].map(f => `dist/src/external-actions/p1b/${f}.js`),
  'dist/schemas/external-actions/observation-1.schema.json', 'dist/schemas/external-actions/report-1.schema.json',
  'package-lock.json',
];

export interface RunOptions { root: string; out: string; guardId: string; guardSource: string; inject: Set<Injection>; cases?: string[] }
export interface RunOutcome { result: P1bResult; env: EnvCheck; out: string }

export function writeRunBundle(root: string, out: string, profileSha: string, configSha: string, guard: { id: string; sha256: string }, observations: unknown[], records: unknown[], result: P1bResult, extra: Record<string, unknown>) {
  const files: { path: string; sha256: string }[] = [];
  const write = (p: string, content: string) => { mkdirSync(dirname(join(out, p)), { recursive: true }); writeFileSync(join(out, p), content); files.push({ path: p, sha256: sha256Hex(content) }); };
  const errors = validateReport(result.report);
  if (errors.length) throw new Error(`report schema: ${errors.join('; ')}`);
  write('evidence.jsonl', canonicalJsonLines(result.report.evidence));
  write('report.json', reportJson(result.report));
  write('summary.md', summary(result.report));
  write('run-records.json', canonicalJson(records) + '\n');
  const { profile } = loadP1bProfile(root);
  const canonical = profile.cases.map(id => {
    const i = observations.findIndex(o => (o as { case_id?: string })?.case_id === id);
    const r = records.find(x => (x as { case_id?: string })?.case_id === id);
    return canonicalCase(i >= 0 ? observations[i] : null, r ?? null, result.evidence.find(e => e.case_id === id) ?? null, profile.timing);
  });
  write('canonical.json', canonicalBytes(canonical));
  const implementation = P1B_IMPLEMENTATION.map(path => ({ path, sha256: sha256Hex(readFileSync(join(root, path))) }));
  writeFileSync(join(out, 'manifest.json'), canonicalJson({ version: VERSION, evidence_kind: 'local_reference_run', profile_sha256: profileSha, run_config_sha256: configSha, guard, ...extra, implementation_sha256: sha256Hex(canonicalJson(implementation)), implementation, files }) + '\n');
}

export async function p1bRun(o: RunOptions): Promise<RunOutcome> {
  const issues = p1bConfigIssues(o.root);
  if (issues.length) throw new Error(`P1b configuration rejected: ${issues.join('; ')}`);
  const { profile: fullProfile, sha256: profileSha } = loadP1bProfile(o.root);
  const { config, sha256: configSha } = loadRunConfig(o.root);
  const profile = o.cases ? { ...fullProfile, profile_id: `${fullProfile.profile_id}/development-subset`, cases: fullProfile.cases.filter(c => o.cases!.includes(c)) } : fullProfile;
  const profileShaUsed = o.cases ? sha256Hex(canonicalJson(profile)) : profileSha;
  const out = resolve(o.out);
  const created = mkdirHandedBack(dirname(out));
  mkdirSync(out);
  const rawDir = join(out, 'raw');
  mkdirSync(rawDir);
  const cases0 = generateCases();
  const env = await envCheck(config, profile.cases.some(id => cases0.find(c => c.id === id)!.attempts.some(a => a.conditions.includes('delay_element'))));
  writeFileSync(join(out, 'environment.json'), canonicalJson(env) + '\n');
  const cases = generateCases();
  const rid = randomBytes(3).toString('hex');
  const guard = { id: o.guardId, sha256: sha256Hex(o.guardSource) };
  const observations: unknown[] = [], records: unknown[] = [];
  const logs: string[] = [];
  if (!env.ok) {
    // Missing isolation: no case runs; every case is a technical error (no skip, no unprotected fallback).
    for (const id of profile.cases) records.push({ format: 'external-action-run-record/1', case_id: id, missing: true, errors: env.checks.filter(c => !c.ok).map(c => ({ code: 'environment_check_failed', message: `${c.name}: ${c.detail}` })) });
  } else {
    const code = prepareCode(o.root, rid, o.guardSource);
    try {
      for (const id of profile.cases) {
        const c = cases.find(x => x.id === id)!;
        const r = await runCase({ root: o.root, runId: `${rid}`, rid, c, plan: planCase(c, profile, config), profile, config, code, guardId: o.guardId, inject: o.inject, rawDir });
        if (r.observation) observations.push(r.observation);
        records.push(r.record);
        logs.push(`# ${id}`, ...r.log);
        process.stderr.write(`[p1b ${o.guardId}] ${id} done\n`);
      }
    } finally { teardownRun(rid); }
  }
  writeFileSync(join(rawDir, 'run-records.json'), canonicalJson(records) + '\n');
  writeFileSync(join(out, 'run.log'), logs.join('\n') + '\n');
  const result = evaluateP1bRun(profile, profileShaUsed, config, { observations: profile.cases.map(id => observations.find(x => (x as { case_id?: string }).case_id === id) ?? { case_id: id, missing: true }), records });
  writeRunBundle(o.root, out, profileShaUsed, configSha, guard, observations, records, result, { command: 'p1b-run', injections: [...o.inject].sort(), development_subset: o.cases ?? null, environment_ok: env.ok });
  handBack(out);
  for (const d of created) handBack(d, false);
  return { result, env, out };
}

/** Gives the output back to the user who invoked sudo (recursively, or the directory alone). */
export function handBack(path: string, recursive = true) {
  const uid = Number(process.env.SUDO_UID), gid = Number(process.env.SUDO_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0) return;
  const walk = (p: string) => { chownSync(p, uid, gid); if (recursive && statSync(p).isDirectory()) for (const x of readdirSync(p)) walk(join(p, x)); };
  walk(path);
}
/** Creates a directory and its missing parents; returns the directories it created, outermost first. */
export function mkdirHandedBack(path: string): string[] {
  const missing: string[] = [];
  for (let p = resolve(path); !existsSync(p); p = dirname(p)) missing.unshift(p);
  mkdirSync(path, { recursive: true });
  return missing;
}
export { P1B_PATHS };
