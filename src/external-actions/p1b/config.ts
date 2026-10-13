/**
 * External Action Boundary Evaluation, P1b: run configuration and per-case plans (docs/external-actions/decisions.md,
 * "P1b decisions"). The run configuration pins the P1b values that are not part of the P1a profile format: the driver's
 * answer timeout, the retry hold and delay, the retry start limit, the network layout and the OS users.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../util/hash';
import { generateCases } from '../corpus/cases';
import { profileIssues } from '../eval/run';
import { Attempt, CaseDef, formOf, Profile, Recipient, RECIPIENTS, RecipientMode } from '../spec/model';

export const RUN_CONFIG_FORMAT = 'external-action-p1b-run/1';
export const P1B_PATHS = {
  profile: 'profiles/external-actions/p1b-local-reference.profile.json',
  profileSha: 'profiles/external-actions/p1b-local-reference.profile.sha256',
  runConfig: 'profiles/external-actions/p1b-local-reference.run.json',
  runConfigSha: 'profiles/external-actions/p1b-local-reference.run.sha256',
  guard: 'guards/external-actions/reference-guard.cjs',
  mutants: 'mutations/external-actions/guard-mutants.json',
  mutantsSha: 'mutations/external-actions/guard-mutants.sha256',
  patches: 'mutations/external-actions/guard',
};

export interface RunConfig {
  format: typeof RUN_CONFIG_FORMAT;
  run_config_id: string;
  profile_sha256: string;
  timing: {
    driver_answer_timeout_ms: number;
    retry_once_hold_ms: number;
    retry_delayed_netem_ms: number;
    retry_start_limit_ms: number;
    probe_timeout_ms: number;
    poll_interval_ms: number;
  };
  network: {
    recipients: Record<Recipient, { address: string; port: number; host: string }>;
    shared_identity: string;
    per_attempt_identities: string[];
    canary: { address: string; tcp_ports: number[]; dns_port: number };
    no_route_probe: string;
    filtered_probe_port: number;
  };
  users: { executor: string; doubles: string; observer: string };
}

export function loadRunConfig(root: string): { config: RunConfig; sha256: string } {
  const bytes = readFileSync(join(root, P1B_PATHS.runConfig));
  return { config: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
}
export function loadP1bProfile(root: string): { profile: Profile; sha256: string } {
  const bytes = readFileSync(join(root, P1B_PATHS.profile));
  return { profile: JSON.parse(bytes.toString('utf8')), sha256: sha256Hex(bytes) };
}

/** Fail-closed checks of the pinned P1b profile and run configuration. */
export function p1bConfigIssues(root: string): string[] {
  const issues: string[] = [];
  const read = (p: string) => { try { return readFileSync(join(root, p), 'utf8'); } catch { issues.push(`${p} missing`); return ''; } };
  const { profile, sha256: profileSha } = loadP1bProfile(root);
  const { config, sha256: configSha } = loadRunConfig(root);
  if (read(P1B_PATHS.profileSha).trim() !== profileSha) issues.push('P1b profile sha256 pin does not match');
  if (read(P1B_PATHS.runConfigSha).trim() !== configSha) issues.push('P1b run configuration sha256 pin does not match');
  issues.push(...profileIssues(profile, generateCases()).map(x => `P1b profile: ${x}`));
  if (config.format !== RUN_CONFIG_FORMAT) issues.push(`run configuration format must be ${RUN_CONFIG_FORMAT}`);
  if (config.profile_sha256 !== profileSha) issues.push('run configuration does not bind the P1b profile');
  const t = config.timing;
  const want = { driver_answer_timeout_ms: 1000, retry_once_hold_ms: 3000, retry_delayed_netem_ms: 3000, retry_start_limit_ms: 500 };
  for (const [k, v] of Object.entries(want)) if ((t as unknown as Record<string, number>)[k] !== v) issues.push(`run configuration ${k} must be ${v} (decisions, P1b)`);
  const p = profile.timing;
  if (p.T_w_ms !== 10000 || p.T_q_ms !== 10000 || p.T_r_ms !== 10000 || p.xm13a_delay_ms !== 1000 || p.xm13b_delay_ms !== 20000 || p.deferred_persist_ms !== 500) issues.push('P1b profile timing differs from the pinned decisions');
  if (t.retry_once_hold_ms <= t.driver_answer_timeout_ms) issues.push('retry-once hold must exceed the driver timeout');
  if (t.retry_delayed_netem_ms <= t.driver_answer_timeout_ms + t.retry_start_limit_ms || t.retry_delayed_netem_ms >= p.T_q_ms) issues.push('retry-delayed netem delay must exceed the driver timeout plus the retry start limit and stay below T_q');
  return issues;
}

/** What the driver asks the guard to send for one attempt (the agent's tool call). */
export interface AttemptRequest {
  id: string;
  route: Attempt['route'];
  recipient: Recipient;
  host: string;
  address: string;
  port: number;
  method: 'POST' | null;
  /** null for a connection without a request. */
  path: string | null;
  fields: Record<string, string> | null;
  connection: string;
  /** Keep the connection open for the next attempt of the same keep-alive group. */
  keep_open: boolean;
}
export interface IdentityPlan { ns: string; address: string }
export interface CasePlan {
  case_id: string;
  attempts: { request: AttemptRequest; identity: IdentityPlan; network_identity: string | null; hook: 'hold_before_forward' | null }[];
  /** Attempts that share one window (keep-alive groups), in order. */
  groups: string[][];
  identities: IdentityPlan[];
  recipients: Record<Recipient, { mode: RecipientMode; hold_first_submission_ms: number; deferred_persist_ms: number }>;
  delay_element: null | { attempt: string; identity: string; delay_ms: number };
  policy: { grants: CaseDef['grants']; forms: CaseDef['forms'] };
}

const pathOf = (a: Attempt): string | null => a.action === 'connect_only' ? null : `/forms/${a.form_id}/${a.action === 'fill' ? 'fill' : a.action === 'autosave_submit' ? 'autosave' : 'submit'}`;

/** The per-case plan follows from the case definition and the pinned configuration only. */
export function planCase(c: CaseDef, profile: Profile, config: RunConfig): CasePlan {
  const identities: IdentityPlan[] = c.per_attempt_identity
    ? c.attempts.map((_a, i) => ({ ns: `x${i + 1}`, address: config.network.per_attempt_identities[i] }))
    : [{ ns: 'x0', address: config.network.shared_identity }];
  if (identities.some(x => !x.address)) throw new Error(`case ${c.id}: not enough per-attempt identities configured`);
  const groups: string[][] = [];
  c.attempts.forEach((a, i) => {
    const prev = c.attempts[i - 1];
    if (prev && prev.connection === a.connection && prev.recipient === a.recipient) groups[groups.length - 1].push(a.id); else groups.push([a.id]);
  });
  const attempts = c.attempts.map((a, i) => {
    formOf(c, a.form_id);
    const group = groups.find(g => g.includes(a.id))!;
    const r = config.network.recipients[a.recipient];
    const identity = c.per_attempt_identity ? identities[i] : identities[0];
    const request: AttemptRequest = {
      id: a.id, route: a.route, recipient: a.recipient, host: r.host, address: r.address, port: r.port,
      method: a.action === 'connect_only' ? null : 'POST', path: pathOf(a), fields: a.action === 'connect_only' ? null : { ...a.fields },
      connection: a.connection, keep_open: group[group.length - 1] !== a.id,
    };
    return { request, identity, network_identity: c.per_attempt_identity ? identity.address : null, hook: a.conditions.includes('guard_timeout_before_forward') ? 'hold_before_forward' as const : null };
  });
  const delayed = c.attempts.findIndex(a => a.conditions.includes('delay_element'));
  const holdAt = (r: Recipient) => c.attempts.some(a => a.recipient === r && a.conditions.includes('guard_timeout_after_forward') && !a.conditions.includes('delay_element')) ? config.timing.retry_once_hold_ms : 0;
  const recipients = Object.fromEntries(RECIPIENTS.map(r => [r, { mode: c.recipient_modes[r], hold_first_submission_ms: holdAt(r), deferred_persist_ms: profile.timing.deferred_persist_ms }])) as CasePlan['recipients'];
  return {
    case_id: c.id, attempts, groups, identities, recipients,
    delay_element: delayed < 0 ? null : { attempt: c.attempts[delayed].id, identity: attempts[delayed].identity.ns, delay_ms: config.timing.retry_delayed_netem_ms },
    policy: { grants: c.grants, forms: c.forms },
  };
}
