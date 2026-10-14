/**
 * P1b privileged regressions (work order §7): real runs with an injected environment fault, each with its expected
 * outcome, and checks of the control run (keep-alive, shared retry state, per-attempt attribution).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, Observation } from '../spec/model';
import { guardSource } from './gate';
import type { Injection } from './orchestrator';
import type { RunRecord } from './record';
import { p1bRun } from './run';

interface Expect { exit: number; cases: Record<string, (e: Evidence) => string[]> }
const has = (e: Evidence, code: string) => e.errors.some(x => x.code === code) ? [] : [`no error ${code} (${e.errors.map(x => x.code).join(',')})`];
const verdict = (e: Evidence, v: string) => e.verdict === v ? [] : [`verdict ${e.verdict}, expected ${v}`];
const effect = (e: Evidence, reason: string, recipient: string) => e.effect_findings.some(f => f.reason === reason && f.recipient === recipient) ? [] : [`no effect finding ${reason}@${recipient}`];
const decision = (e: Evidence, reason: string, attempt: string) => e.decision_findings.some(f => f.reason === reason && f.attempt === attempt) ? [] : [`no decision finding ${reason}@${attempt}`];
const errMsg = (e: Evidence, needle: string) => e.errors.some(x => x.message.includes(needle)) ? [] : [`no error mentioning ${needle}`];

export const PRIVILEGED_REGRESSIONS: { id: string; meaning: string; guard: string; inject: Injection[]; cases: string[]; expect: Expect }[] = [
  { id: 'PR1', meaning: 'missing isolation (no packet filter) is a technical error, exit 2', guard: 'reference', inject: ['no-filter'], cases: ['submit-allowed-P'],
    expect: { exit: 2, cases: { 'submit-allowed-P': e => [...verdict(e, 'HARNESS_ERROR'), ...has(e, 'harness_isolation_setup'), ...has(e, 'isolation_probe_failed')] } } },
  { id: 'PR2', meaning: 'a writable observation channel is a technical error', guard: 'reference', inject: ['journal-writable'], cases: ['submit-allowed-P'],
    expect: { exit: 2, cases: { 'submit-allowed-P': e => [...verdict(e, 'HARNESS_ERROR'), ...has(e, 'observation_channel_unprotected')] } } },
  { id: 'PR3', meaning: 'a missing observation channel (no journal at P) is a technical error and P is incomplete', guard: 'reference', inject: ['no-journal-P'], cases: ['submit-allowed-P'],
    expect: { exit: 2, cases: { 'submit-allowed-P': e => [...verdict(e, 'HARNESS_ERROR'), ...has(e, 'harness_journal_unreadable'), ...(e.incomplete.some(x => x.flag === 'journal') ? [] : ['no journal incompleteness'])] } } },
  { id: 'PR4', meaning: 'an observation channel visible to the executor is a technical error', guard: 'reference', inject: ['no-mount-hide'], cases: ['submit-allowed-P'],
    expect: { exit: 2, cases: { 'submit-allowed-P': e => [...verdict(e, 'HARNESS_ERROR'), ...has(e, 'isolation_probe_failed')] } } },
  { id: 'PR5', meaning: 'a failed provisional closure: later attempts not issued and not assessed, cleanup runs, exit 2', guard: 'reference', inject: ['hold-connection'], cases: ['fill-no-submit', 'submit-allowed-P'],
    expect: { exit: 2, cases: { 'fill-no-submit': e => [...verdict(e, 'UNASSESSABLE'), ...(e.not_assessed.some(x => x.attempt === 'a2') ? [] : ['a2 is not marked not issued']), ...(e.closure.post_cleanup_used ? [] : ['no post-cleanup collection']), ...(e.errors.length ? [`errors ${e.errors.map(x => x.code)}`] : [])] } } },
  { id: 'PR6', meaning: 'a forbidden effect confirmed by the collection after cleanup is kept beside the missing closure', guard: 'XM12', inject: ['executor-linger'], cases: ['deferred-persist-forbidden', 'deferred-persist-allowed'],
    expect: { exit: 2, cases: { 'deferred-persist-forbidden': e => [...verdict(e, 'VIOLATION'), ...effect(e, 'unexpected_submission_received', 'P'), ...(e.incomplete.some(x => x.flag === 'closure') ? [] : ['no closure incompleteness']), ...(e.closure.post_cleanup_used ? [] : ['no post-cleanup collection'])] } } },
  { id: 'PR7', meaning: 'separate guard state per attempt loses the retry state: the retry is a duplicate', guard: 'reference', inject: ['guard-per-attempt'], cases: ['retry-once', 'retry-after-unsent'],
    expect: { exit: 1, cases: { 'retry-once': e => [...verdict(e, 'VIOLATION'), ...decision(e, 'false_allow', 'a2'), ...effect(e, 'submission_duplicate', 'P')] } } },
  { id: 'PR8', meaning: 'a guard that tries to create a descendant process is denied by the permission model (prevention is active), a technical error', guard: 'reference', inject: ['spawn-child'], cases: ['submit-allowed-P'],
    expect: { exit: 2, cases: { 'submit-allowed-P': e => [...verdict(e, 'HARNESS_ERROR'), ...errMsg(e, 'descendant_creation_denied'), ...(e.errors.some(x => x.message.includes('descendant_creation_allowed')) ? ['the permission model allowed a descendant process: prevention is not active'] : [])] } } },
];

/** Checks of the control run: keep-alive with one connection and two requests, shared retry state, attribution. */
export function controlChecks(dir: string): string[] {
  const problems: string[] = [];
  const ev = readFileSync(join(dir, 'evidence.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Evidence);
  const obs = (id: string) => JSON.parse(readFileSync(join(dir, 'raw', `${id}.observation.json`), 'utf8')) as Observation;
  const records = JSON.parse(readFileSync(join(dir, 'run-records.json'), 'utf8')) as RunRecord[];
  const ka = obs('keepalive-multi-P');
  const j = ka.journals.P ?? [];
  const conns = j.filter(e => e.kind === 'connection_accepted');
  const reqs = j.filter(e => e.kind === 'request_received') as Extract<typeof j[number], { kind: 'request_received' }>[];
  if (conns.length !== 1 || reqs.length !== 2 || new Set(reqs.map(r => r.connection_id)).size !== 1) problems.push(`keep-alive: ${conns.length} connections and ${reqs.length} requests`);
  if (ka.attempts.some(a => a.window?.fence_id !== 'w1-2' || a.window?.status !== 'closed')) problems.push('keep-alive: the attempts do not share the closed group window w1-2');
  const attr = (id: string) => ev.find(e => e.case_id === id)?.effects.filter(x => x.class === 'submission_received').map(x => `${x.attribution.level}:${x.attribution.attempts.join('+')}`) ?? [];
  for (const [id, want] of [['retry-once', 'attributed:a1'], ['retry-delayed', 'attributed:a1'], ['retry-after-unsent', 'attributed:a2']]) if (attr(id).join(',') !== want) problems.push(`${id}: submission attribution ${attr(id).join(',')}, expected ${want}`);
  const ro = records.find(r => r.case_id === 'retry-once');
  const a2 = ro?.timeline.attempts.find(a => a.id === 'a2');
  if (!ro || ro.timeline.attempts.find(a => a.id === 'a1')?.recorded_decision !== 'UNKNOWN' || a2?.recorded_decision !== 'DENY') problems.push('retry-once: the forwarded first attempt must time out and the retry be denied by the shared retry state');
  const rd = records.find(r => r.case_id === 'retry-delayed');
  if (!rd || rd.timeline.attempts.find(a => a.id === 'a2')?.recorded_decision !== 'DENY') problems.push('retry-delayed: the retry must be denied');
  for (const e of ev) if (e.verdict !== 'PASS') problems.push(`${e.case_id}: ${e.verdict}`);
  return problems;
}

export async function runPrivilegedRegressions(root: string, out: string, controlDir: string | null) {
  const results: { id: string; meaning: string; exit: number; ok: boolean; problems: string[] }[] = [];
  for (const r of PRIVILEGED_REGRESSIONS) {
    const run = await p1bRun({ root, out: join(out, r.id), guardId: r.guard, guardSource: guardSource(root, r.guard), inject: new Set(r.inject), cases: r.cases });
    const problems: string[] = [];
    if (run.result.report.exit_code !== r.expect.exit) problems.push(`exit ${run.result.report.exit_code}, expected ${r.expect.exit}`);
    for (const [id, f] of Object.entries(r.expect.cases)) { const e = run.result.evidence.find(x => x.case_id === id); problems.push(...(e ? f(e).map(p => `${id}: ${p}`) : [`${id}: no evidence`])); }
    results.push({ id: r.id, meaning: r.meaning, exit: run.result.report.exit_code, ok: problems.length === 0, problems });
    process.stderr.write(`[p1b regressions] ${r.id} ${problems.length ? 'FAILED ' + problems.join('; ') : 'ok'}\n`);
  }
  const control = controlDir ? controlChecks(controlDir) : ['no control run given'];
  return { ok: results.every(r => r.ok) && control.length === 0, results, control: { ok: control.length === 0, problems: control } };
}
