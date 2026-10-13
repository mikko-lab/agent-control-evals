/**
 * P1b root orchestrator (decisions, "Isolation and privileges"). Runs as root. It does the privileged setup and
 * teardown of each case, starts every process as its own unprivileged user, relays the messages between the case
 * runner (H) and the executor (E) and reports the executor's process exits. No privileged step runs during the case.
 *
 * Every process is started as
 *   nsenter --net=<ns> -- unshare -m --propagation private -- sh -c '<cgroup join>; <tmpfs over /run/ea>; exec setpriv ...'
 * with the user's ids, cleared supplementary groups, no_new_privs and an empty capability bounding set.
 */
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { chmodSync, chownSync, closeSync, constants, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../../util/hash';
import { CaseDef, Profile, Recipient } from '../spec/model';
import type { CasePlan, RunConfig } from './config';
import type { CaseRunnerConfig } from './case-runner';
import type { DoublesConfig } from './doubles';
import type { ExecutorConfig } from './executor';
import type { ProbeResult } from './record';

export const RUN_BASE = '/run/ea';
export const CODE_BASE = '/run/ea-code';
export const EXEC_BASE = '/run/ea-exec';
const nowUs = (): number => Number(process.hrtime.bigint() / 1000n);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type Injection = 'no-filter' | 'journal-writable' | 'no-mount-hide' | 'hold-connection' | 'executor-linger' | 'guard-per-attempt' | 'no-journal-P' | 'no-netem';
export const INJECTIONS: Injection[] = ['no-filter', 'journal-writable', 'no-mount-hide', 'hold-connection', 'executor-linger', 'guard-per-attempt', 'no-journal-P', 'no-netem'];

export function sh(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], input, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
}
export const tryShell = (cmd: string, args: string[]): { ok: boolean; out: string } => { try { return { ok: true, out: sh(cmd, args) }; } catch (e) { return { ok: false, out: String((e as { stderr?: string }).stderr ?? e) }; } };

export interface Ids { uid: number; gid: number }
export function ids(user: string): Ids { return { uid: Number(sh('id', ['-u', user]).trim()), gid: Number(sh('id', ['-g', user]).trim()) }; }

export function cgroupRoot(): string | null {
  const mounts = readFileSync('/proc/mounts', 'utf8').split('\n').map(l => l.split(' ')).filter(f => f[2] === 'cgroup2');
  return mounts.length ? mounts[0][1] : null;
}

const WRAP = [
  'set -e',
  'if [ -n "$EA_CGROUP" ]; then echo $$ > "$EA_CGROUP/cgroup.procs"; fi',
  'if [ -n "$EA_HIDE" ]; then mount -t tmpfs -o mode=0755,size=64k ea-hidden "$EA_HIDE"; fi',
  'exec setpriv --reuid "$EA_UID" --regid "$EA_GID" --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- "$@"',
].join('\n');

/** Starts a command as an unprivileged user in a network namespace (and optionally a cgroup, with the run directory hidden). */
export function spawnAs(o: { ns: string; user: Ids; argv: string[]; cgroup?: string; hide?: string; cwd?: string; stdio?: (number | 'pipe' | 'ignore' | 'inherit')[] }): ChildProcess {
  return spawn('nsenter', [`--net=/run/netns/${o.ns}`, '--', 'unshare', '-m', '--propagation', 'private', '--', 'sh', '-c', WRAP, 'ea-wrap', ...o.argv], {
    cwd: o.cwd ?? '/', stdio: o.stdio ?? ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', HOME: '/nonexistent', EA_UID: String(o.user.uid), EA_GID: String(o.user.gid), EA_CGROUP: o.cgroup ?? '', EA_HIDE: o.hide ?? '' },
  });
}

/** Collects one process's output and exit. */
function collect(p: ChildProcess): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    p.stdout?.on('data', d => { stdout += d; });
    p.stderr?.on('data', d => { stderr += d; });
    p.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
const waitLine = (p: ChildProcess, text: string, ms: number): Promise<boolean> => new Promise(resolve => {
  let buf = '';
  let err = '';
  p.stderr?.on('data', d => { err += d; (p as ChildProcess & { errText?: string }).errText = err; });
  const t = setTimeout(() => resolve(false), ms);
  p.stdout?.on('data', d => { buf += d; if (buf.includes(text)) { clearTimeout(t); resolve(true); } });
  p.on('exit', () => { clearTimeout(t); resolve(buf.includes(text)); });
});
const waitPath = async (path: string, ms: number) => { const end = Date.now() + ms; while (!existsSync(path)) { if (Date.now() > end) return false; await sleep(10); } return true; };

/** Copies the compiled child code and the guard under test to a root-owned, world-readable directory. */
export function prepareCode(root: string, runId: string, guardSource: string): { dir: string; guardPath: string; guardSha256: string } {
  const dir = join(CODE_BASE, runId);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(CODE_BASE, 0o755);
  for (const sub of ['dist/src/external-actions/p1b', 'dist/src/external-actions/spec', 'dist/src/util']) cpSync(join(root, sub), join(dir, sub), { recursive: true });
  const guardPath = join(dir, 'guard', 'guard.cjs');
  mkdirSync(dirname(guardPath), { recursive: true });
  writeFileSync(guardPath, guardSource);
  const walk = (p: string) => { const s = statSync(p); if (s.isDirectory()) { chmodSync(p, 0o755); for (const x of readdirSync(p)) walk(join(p, x)); } else chmodSync(p, 0o644); };
  walk(dir);
  return { dir, guardPath, guardSha256: sha256Hex(guardSource) };
}

interface Net { rid: string; ns: Record<string, string>; identities: { key: string; ns: string; address: string; vex: string; vdbl: string }[]; canary: { vcan: string; vdbl: string } }

function nsNames(rid: string, plan: CasePlan): Net {
  const ns: Record<string, string> = { d: `ea${rid}d`, g: `ea${rid}g`, h: `ea${rid}h`, c: `ea${rid}c` };
  const identities = plan.identities.map(x => { ns[x.ns] = `ea${rid}${x.ns}`; return { key: x.ns, ns: ns[x.ns], address: x.address, vex: `ea${rid}${x.ns}e`, vdbl: `ea${rid}${x.ns}d` }; });
  return { rid, ns, identities, canary: { vcan: `ea${rid}ce`, vdbl: `ea${rid}cd` } };
}

const filterRules = (cfg: RunConfig) => [
  '*filter', ':INPUT DROP [0:0]', ':FORWARD DROP [0:0]', ':OUTPUT DROP [0:0]',
  '-A INPUT -i lo -j ACCEPT', '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT', '-A INPUT -j DROP',
  '-A OUTPUT -o lo -j ACCEPT', '-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
  ...(['P', 'Q'] as Recipient[]).map(r => `-A OUTPUT -d ${cfg.network.recipients[r].address}/32 -p tcp -m tcp --dport ${cfg.network.recipients[r].port} -j ACCEPT`),
  '-A OUTPUT -j DROP', 'COMMIT', '',
].join('\n');
const lockedRules = ['*filter', ':INPUT DROP [0:0]', ':FORWARD DROP [0:0]', ':OUTPUT DROP [0:0]', '-A INPUT -i lo -j ACCEPT', '-A INPUT -j DROP', '-A OUTPUT -o lo -j ACCEPT', '-A OUTPUT -j DROP', 'COMMIT', ''].join('\n');

function setupNetwork(net: Net, cfg: RunConfig, plan: CasePlan, inject: Set<Injection>) {
  const ip = (...a: string[]) => sh('ip', a);
  const inNs = (ns: string, cmd: string, ...a: string[]) => sh('ip', ['netns', 'exec', ns, cmd, ...a]);
  for (const n of Object.values(net.ns)) {
    ip('netns', 'add', n);
    // No case namespace uses IPv6; it is off before any link exists, so no address changes state during the case.
    if (existsSync('/proc/sys/net/ipv6')) inNs(n, 'sysctl', '-q', '-w', 'net.ipv6.conf.all.disable_ipv6=1', 'net.ipv6.conf.default.disable_ipv6=1');
    ip('-n', n, 'link', 'set', 'lo', 'up');
  }
  const d = net.ns.d;
  // P and Q live on the doubles' loopback; the doubles' namespace forwards towards the canary only.
  for (const r of ['P', 'Q'] as Recipient[]) ip('-n', d, 'addr', 'add', `${cfg.network.recipients[r].address}/32`, 'dev', 'lo');
  inNs(d, 'sysctl', '-q', '-w', 'net.ipv4.ip_forward=1');
  for (const x of net.identities) {
    ip('link', 'add', x.vex, 'netns', x.ns, 'type', 'veth', 'peer', 'name', x.vdbl, 'netns', d);
    ip('-n', x.ns, 'addr', 'add', `${x.address}/32`, 'dev', x.vex);
    ip('-n', x.ns, 'link', 'set', x.vex, 'up');
    ip('-n', d, 'link', 'set', x.vdbl, 'up');
    ip('-n', x.ns, 'route', 'add', '10.88.0.0/24', 'dev', x.vex, 'src', x.address);
    ip('-n', d, 'route', 'add', `${x.address}/32`, 'dev', x.vdbl);
  }
  ip('link', 'add', net.canary.vcan, 'netns', net.ns.c, 'type', 'veth', 'peer', 'name', net.canary.vdbl, 'netns', d);
  ip('-n', net.ns.c, 'addr', 'add', `${cfg.network.canary.address}/32`, 'dev', net.canary.vcan);
  ip('-n', net.ns.c, 'link', 'set', net.canary.vcan, 'up');
  ip('-n', d, 'link', 'set', net.canary.vdbl, 'up');
  ip('-n', net.ns.c, 'route', 'add', '10.77.0.0/16', 'dev', net.canary.vcan);
  // The canary double (D) listens on 80, 443 and 53 without privileges: a setting local to the canary's namespace.
  inNs(net.ns.c, 'sysctl', '-q', '-w', 'net.ipv4.ip_unprivileged_port_start=0');
  ip('-n', d, 'route', 'add', `${cfg.network.canary.address}/32`, 'dev', net.canary.vdbl);
  for (const x of net.identities) if (!inject.has('no-filter')) sh('ip', ['netns', 'exec', x.ns, 'iptables-restore'], filterRules(cfg));
  for (const n of [net.ns.g, net.ns.h]) sh('ip', ['netns', 'exec', n, 'iptables-restore'], lockedRules);
  if (plan.delay_element && !inject.has('no-netem')) {
    const x = net.identities.find(i => i.key === plan.delay_element!.identity)!;
    inNs(d, 'tc', 'qdisc', 'add', 'dev', x.vdbl, 'root', 'netem', 'delay', `${plan.delay_element.delay_ms}ms`);
  }
}

/** Configuration record (decisions, "Configuration record"): every case namespace, without counters or statistics. */
function configRecord(net: Net): string {
  const parts: string[] = [];
  for (const [key, n] of Object.entries(net.ns).sort()) {
    const run = (cmd: string, ...a: string[]) => { const r = tryShell('ip', ['netns', 'exec', n, cmd, ...a]); return r.ok ? r.out : `ERROR ${r.out}`; };
    parts.push(`## ${key}`, run('ip', '-d', 'addr'), run('ip', 'route', 'show', 'table', 'all'),
      run('iptables-save').split('\n').filter(l => !l.startsWith('#')).join('\n'), run('tc', 'qdisc', 'show'),
      `ip_forward=${run('cat', '/proc/sys/net/ipv4/ip_forward').trim()}`,
      `ipv6_disabled=${existsSync('/proc/sys/net/ipv6') ? run('cat', '/proc/sys/net/ipv6/conf/all/disable_ipv6').trim() : 'no-ipv6'}`);
  }
  return parts.join('\n');
}
function dropCounters(net: Net): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(net.ns).sort()) {
    const r = tryShell('ip', ['netns', 'exec', n, 'iptables-save', '-c']);
    if (!r.ok) continue;
    let i = 0;
    for (const l of r.out.split('\n')) {
      const pol = /^:(\w+) DROP \[(\d+):\d+\]/.exec(l);
      if (pol) out[`${key}:${pol[1]}:policy`] = Number(pol[2]);
      const rule = /^\[(\d+):\d+\] -A (\w+) .*-j DROP/.exec(l);
      if (rule) out[`${key}:${rule[2]}:${i++}`] = Number(rule[1]);
    }
  }
  return out;
}
export function filterIssues(net: Net, cfg: RunConfig): string[] {
  const issues: string[] = [];
  const norm = (s: string) => s.split('\n').filter(l => l && !l.startsWith('#')).join('\n');
  for (const x of net.identities) {
    const r = tryShell('ip', ['netns', 'exec', x.ns, 'iptables-save']);
    if (!r.ok || norm(r.out) !== norm(filterRules(cfg))) issues.push(`executor namespace ${x.key}: packet filter is not the pinned rule set`);
    const routes = tryShell('ip', ['-n', x.ns, 'route', 'show', 'table', 'all']).out;
    if (/default/.test(routes)) issues.push(`executor namespace ${x.key} has a default route`);
  }
  return issues;
}

export interface CaseResult { observation: unknown | null; record: unknown | null; log: string[] }

/** Runs one case end to end. Every failure of the setup or the processes is recorded; teardown always runs. */
export async function runCase(o: {
  root: string; runId: string; rid: string; c: CaseDef; plan: CasePlan; profile: Profile; config: RunConfig;
  code: { dir: string; guardPath: string; guardSha256: string }; guardId: string; inject: Set<Injection>; rawDir: string;
}): Promise<CaseResult> {
  const log: string[] = [];
  const note = (s: string) => log.push(`${new Date().toISOString()} ${s}`);
  const { plan, config, rid } = o;
  const net = nsNames(rid, plan);
  const users = { E: ids(config.users.executor), D: ids(config.users.doubles), H: ids(config.users.observer) };
  const caseDir = join(RUN_BASE, rid, o.c.id);
  const dirs = { journal: join(caseDir, 'journal'), ctl: join(caseDir, 'ctl'), h: join(caseDir, 'h'), ipc: join(caseDir, 'ipc'), cfg: join(caseDir, 'cfg') };
  const execDir = join(EXEC_BASE, rid, o.c.id);
  const cgRoot = cgroupRoot();
  const cgroup = cgRoot ? join(cgRoot, `ea-p1b-${rid}`, o.c.id) : '';
  const procs: ChildProcess[] = [];
  let observation: unknown | null = null, record: unknown | null = null;
  const setupErrors: string[] = [];
  try {
    // Directories and permissions.
    mkdirSync(RUN_BASE, { recursive: true, mode: 0o755 });
    for (const p of [join(RUN_BASE, rid), caseDir, dirs.cfg]) { mkdirSync(p, { recursive: true }); chmodSync(p, 0o755); }
    for (const p of [dirs.journal, dirs.ctl]) { mkdirSync(p); chownSync(p, users.D.uid, users.H.gid); chmodSync(p, 0o2750); }
    mkdirSync(dirs.h); chownSync(dirs.h, users.H.uid, users.H.gid); chmodSync(dirs.h, 0o700);
    mkdirSync(dirs.ipc); chmodSync(dirs.ipc, 0o700);
    mkdirSync(EXEC_BASE, { recursive: true, mode: 0o755 }); mkdirSync(join(EXEC_BASE, rid), { recursive: true, mode: 0o755 });
    mkdirSync(execDir); chownSync(execDir, users.E.uid, users.E.gid); chmodSync(execDir, 0o700);
    if (!cgRoot) throw new Error('cgroup v2 is not mounted');
    mkdirSync(cgroup, { recursive: true });
    chownSync(join(cgroup, 'cgroup.kill'), users.H.uid, users.H.gid);
    setupNetwork(net, config, plan, o.inject);
    note('network ready');

    const node = process.execPath;
    const js = (name: string) => join(o.code.dir, 'dist/src/external-actions/p1b', `${name}.js`);
    const cfgFile = (name: string, value: unknown) => { const p = join(dirs.cfg, `${name}.json`); writeFileSync(p, JSON.stringify(value, null, 1)); chmodSync(p, 0o644); return p; };
    const execCfgDir = join(o.code.dir, 'cases', o.c.id); mkdirSync(execCfgDir, { recursive: true }); chmodSync(execCfgDir, 0o755);
    const execCfgFile = (name: string, value: unknown) => { const p = join(execCfgDir, `${name}.json`); writeFileSync(p, JSON.stringify(value, null, 1)); chmodSync(p, 0o644); return p; };

    // Canary (D) and doubles (D).
    const canaryJournal = join(dirs.journal, 'canary.jsonl');
    const canary = spawnAs({ ns: net.ns.c, user: users.D, argv: [node, js('canary'), canaryJournal, config.network.canary.address, config.network.canary.tcp_ports.join(','), String(config.network.canary.dns_port)] });
    procs.push(canary);
    if (!(await waitLine(canary, 'ready', 10_000))) throw new Error(`canary double did not start: ${(canary as ChildProcess & { errText?: string }).errText ?? ''}`);
    const doublesCfg: DoublesConfig = {
      journal_dir: dirs.journal, ctl_dir: dirs.ctl,
      recipients: Object.fromEntries((['P', 'Q'] as Recipient[]).map(r => [r, {
        address: config.network.recipients[r].address, port: config.network.recipients[r].port, ...plan.recipients[r],
        forms: plan.policy.forms.filter(f => f.recipient === r),
        inject: { hold_all_responses_ms: o.inject.has('hold-connection') && r === 'P' ? 60_000 : 0, no_journal: o.inject.has('no-journal-P') && r === 'P' },
      }])) as DoublesConfig['recipients'],
    };
    const doubles = spawnAs({ ns: net.ns.d, user: users.D, argv: [node, js('doubles'), cfgFile('doubles', doublesCfg)] });
    procs.push(doubles);
    let doublesErr = ''; doubles.stderr?.on('data', d => { doublesErr += d; });
    if (!(await waitLine(doubles, 'ready', 10_000))) throw new Error(`doubles did not start: ${doublesErr}`);
    if (o.inject.has('journal-writable')) { chmodSync(dirs.journal, 0o2777); for (const f of readdirSync(dirs.journal)) chmodSync(join(dirs.journal, f), 0o666); }
    const netemSock = join(dirs.h, 'netem.sock');
    const reader = spawnAs({ ns: net.ns.d, user: users.H, argv: [node, js('netem-reader'), netemSock] });
    procs.push(reader);
    if (!(await waitLine(reader, 'ready', 10_000))) throw new Error(`netem reader did not start: ${(reader as ChildProcess & { errText?: string }).errText ?? ''}`);
    const netemNow = tryShell('ip', ['netns', 'exec', net.ns.d, 'tc', '-j', 'qdisc', 'show']);
    const netem = netemNow.ok ? (JSON.parse(netemNow.out) as { kind: string; dev: string; options?: { delay?: { delay?: number } } }[]).filter(q => q.kind === 'netem').map(q => ({ dev: q.dev, delay_us: q.options?.delay?.delay !== undefined ? Math.round(q.options.delay.delay * 1e6) : null })) : [];

    // Observation channel: owners and modes as the executor would face them.
    const stat = (p: string) => { try { const s = statSync(p); return { owner: String(s.uid), group: String(s.gid), mode: (s.mode & 0o7777).toString(8) }; } catch { return { owner: 'missing', group: 'missing', mode: 'missing' }; } };
    const channel = {
      journal_dir: stat(dirs.journal), ctl_dir: stat(dirs.ctl),
      journal_files: (['P', 'Q'] as Recipient[]).map(r => ({ recipient: r, ...stat(join(dirs.journal, `${r}.jsonl`)) })),
      ctl_sockets: (['P', 'Q'] as Recipient[]).map(r => ({ recipient: r, ...stat(join(dirs.ctl, `${r}.sock`)) })),
      expected: { owner: String(users.D.uid), group: String(users.H.gid) },
    };

    // Probes as E from every executor namespace, with the run directory hidden as for the executor.
    const probes: { ns: string; results: ProbeResult[] }[] = [];
    for (const x of net.identities) {
      const spec = { hidden_paths: [join(RUN_BASE, rid), caseDir], canary: config.network.canary.address, canary_tcp_port: config.network.canary.tcp_ports[0], canary_dns_port: config.network.canary.dns_port, no_route: config.network.no_route_probe, filtered: { address: config.network.recipients.P.address, port: config.network.filtered_probe_port }, timeout_ms: config.timing.probe_timeout_ms };
      const p = spawnAs({ ns: x.ns, user: users.E, argv: [node, js('probe'), JSON.stringify(spec)], hide: o.inject.has('no-mount-hide') ? '' : RUN_BASE });
      const r = await collect(p);
      try { probes.push({ ns: x.key, results: JSON.parse(r.stdout).probes }); } catch { probes.push({ ns: x.key, results: [{ name: 'probe_process', target: x.key, blocked: false, detail: `probe failed: ${r.code} ${r.stderr.slice(0, 300)}` }] }); }
    }
    const fIssues = filterIssues(net, config);
    setupErrors.push(...fIssues);
    const configBefore = configRecord(net);
    const countersBefore = dropCounters(net);
    note('probes done');

    // Executor: forwarders (one per identity), then the guard host, all as E in the case cgroup.
    const fwd: Record<string, string> = {};
    const execProcs: { name: string; p: ChildProcess }[] = [];
    for (const x of net.identities) {
      const sock = join(execDir, `${x.key}.sock`);
      const p = spawnAs({ ns: x.ns, user: users.E, argv: [node, js('forwarder'), sock], cgroup, hide: o.inject.has('no-mount-hide') ? '' : RUN_BASE });
      procs.push(p); execProcs.push({ name: `forwarder-${x.key}`, p });
      if (!(await waitPath(sock, 10_000))) throw new Error(`forwarder ${x.key} did not start`);
      for (const a of plan.attempts) if (a.identity.ns === x.key) fwd[a.request.id] = sock;
    }
    const fifo = join(dirs.ipc, 'signal');
    sh('mkfifo', ['-m', '0600', fifo]);
    const fifoRead = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const fifoWrite = openSync(fifo, constants.O_WRONLY);
    const execCfg: ExecutorConfig = {
      guard_path: o.code.guardPath, policy: plan.policy, forwarders: fwd,
      hooks: Object.fromEntries(plan.attempts.filter(a => a.hook).map(a => [a.request.id, a.hook!])),
      timing: { xm13a_delay_ms: o.profile.timing.xm13a_delay_ms, xm13b_delay_ms: o.profile.timing.xm13b_delay_ms },
      inject: { linger_ms: o.inject.has('executor-linger') ? 20_000 : 0, guard_per_attempt: o.inject.has('guard-per-attempt') },
    };
    const executor = spawnAs({ ns: net.ns.g, user: users.E, argv: [node, js('executor'), execCfgFile('executor', execCfg)], cgroup, hide: o.inject.has('no-mount-hide') ? '' : RUN_BASE, stdio: ['pipe', 'pipe', 'pipe', fifoRead] });
    closeSync(fifoRead);
    procs.push(executor); execProcs.push({ name: 'executor', p: executor });
    let executorErr = ''; executor.stderr?.on('data', d => { executorErr += d; });

    // Case runner (H).
    const runnerCfg: CaseRunnerConfig = {
      run_id: o.runId, plan, guard: { id: o.guardId, sha256: o.code.guardSha256 },
      timing: { T_w_ms: o.profile.timing.T_w_ms, T_q_ms: o.profile.timing.T_q_ms, T_r_ms: o.profile.timing.T_r_ms, driver_answer_timeout_ms: config.timing.driver_answer_timeout_ms, retry_start_limit_ms: config.timing.retry_start_limit_ms, poll_interval_ms: config.timing.poll_interval_ms },
      ctl: { P: join(dirs.ctl, 'P.sock'), Q: join(dirs.ctl, 'Q.sock') }, journals: { P: join(dirs.journal, 'P.jsonl'), Q: join(dirs.journal, 'Q.jsonl') },
      canary_journal: canaryJournal, netem_socket: netemSock, cgroup_dir: cgroup, out_dir: join(dirs.h, 'out'), executor_processes: execProcs.map(x => x.name),
    };
    const runner = spawnAs({ ns: net.ns.h, user: users.H, argv: [node, js('case-runner'), cfgFile('case-runner', runnerCfg)], stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(runner);
    let runnerErr = ''; runner.stderr?.on('data', d => { runnerErr += d; });
    const toRunner = (m: Record<string, unknown>) => { if (runner.stdin && !runner.stdin.destroyed) runner.stdin.write(JSON.stringify(m) + '\n'); };
    for (const x of execProcs) x.p.on('exit', (code, signal) => toRunner({ type: 'exit', name: x.name, code, signal, at_us: nowUs() }));
    // Executor -> runner: only well-formed messages of the known types.
    let ebuf = '';
    executor.stdout!.on('data', d => {
      ebuf += d;
      let i: number;
      while ((i = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, i); ebuf = ebuf.slice(i + 1);
        const at = nowUs();
        let m: unknown;
        try { m = JSON.parse(line); } catch { toRunner({ type: 'protocol_error', message: 'unparsable executor line' }); continue; }
        const t = (m as { type?: unknown })?.type;
        if (typeof m === 'object' && m !== null && !Array.isArray(m) && (t === 'answer' || t === 'event')) toRunner({ type: 'from_executor', msg: m, at_us: at });
        else toRunner({ type: 'protocol_error', message: `executor message of unknown type ${String(t)}` });
      }
    });
    let signalOpen = true;
    const runnerDone = new Promise<void>(resolve => {
      let rbuf = '';
      runner.stdout!.on('data', d => {
        rbuf += d;
        let i: number;
        while ((i = rbuf.indexOf('\n')) >= 0) {
          const line = rbuf.slice(0, i); rbuf = rbuf.slice(i + 1);
          let m: Record<string, unknown>;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.type === 'to_executor') { if (executor.stdin && !executor.stdin.destroyed) executor.stdin.write(JSON.stringify(m.msg) + '\n'); }
          else if (m.type === 'signal') { if (signalOpen) writeSync(fifoWrite, JSON.stringify({ type: 'closure', fence_id: m.fence_id, attempts: m.attempts }) + '\n'); note(`signal ${String(m.fence_id)}`); }
          else if (m.type === 'end_executor') { if (executor.stdin && !executor.stdin.destroyed) { executor.stdin.write(JSON.stringify({ type: 'end' }) + '\n'); executor.stdin.end(); } if (signalOpen) { closeSync(fifoWrite); signalOpen = false; } }
          else if (m.type === 'kill_note') note('case runner wrote cgroup.kill');
          else if (m.type === 'case_done') {
            const after = configRecord(net);
            toRunner({ type: 'isolation_after', config_sha256: sha256Hex(after), config_text: after, drop_counters: dropCounters(net) });
          }
        }
      });
      runner.on('exit', () => resolve());
    });
    toRunner({ type: 'isolation', config_sha256: sha256Hex(configBefore), config_text: configBefore, drop_counters: countersBefore, probes, netem, channel, setup_issues: setupErrors });
    let guardTimer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([runnerDone.then(() => false), new Promise<boolean>(r => { guardTimer = setTimeout(() => r(true), 180_000); })]);
    clearTimeout(guardTimer);
    note('case runner finished');
    if (timedOut) { note('case runner did not finish within 180 s'); setupErrors.push('case runner did not finish within 180 s'); }
    if (signalOpen) { closeSync(fifoWrite); signalOpen = false; }
    if (runnerErr) note(`case runner stderr: ${runnerErr.slice(0, 2000)}`);
    if (executorErr) note(`executor stderr: ${executorErr.slice(0, 2000)}`);
    const outDir = join(dirs.h, 'out');
    // The raw observation is kept byte for byte as the case runner wrote it.
    try { const raw = readFileSync(join(outDir, 'observation.json')); writeFileSync(join(o.rawDir, `${o.c.id}.observation.json`), raw); observation = JSON.parse(raw.toString('utf8')); } catch (e) { note(`no observation: ${String(e)}`); }
    try { record = JSON.parse(readFileSync(join(outDir, 'run-record.json'), 'utf8')); } catch (e) { note(`no run record: ${String(e)}`); }
  } catch (e) {
    setupErrors.push(String(e));
    note(`case failed technically: ${String(e)}`);
  } finally {
    note('teardown');
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    if (cgroup && existsSync(cgroup)) { try { writeFileSync(join(cgroup, 'cgroup.kill'), '1'); } catch { /* gone */ } }
    await sleep(100);
    for (const n of Object.values(net.ns)) tryShell('ip', ['netns', 'del', n]);
    if (cgroup) { for (let i = 0; i < 50 && existsSync(cgroup); i++) { try { rmSync(cgroup, { recursive: false }); } catch { try { execFileSync('rmdir', [cgroup]); } catch { await sleep(20); } } } }
    rmSync(caseDir, { recursive: true, force: true });
    rmSync(execDir, { recursive: true, force: true });
    note('teardown done');
  }
  if (record && setupErrors.length) (record as { errors: { code: string; message: string }[] }).errors.push(...setupErrors.map(m => ({ code: 'isolation_setup', message: m })));
  return { observation, record: record ?? { format: 'external-action-run-record/1', case_id: o.c.id, errors: setupErrors.map(m => ({ code: 'isolation_setup', message: m })), missing: true }, log };
}

export function teardownRun(rid: string) {
  const cg = cgroupRoot();
  if (cg && existsSync(join(cg, `ea-p1b-${rid}`))) tryShell('rmdir', [join(cg, `ea-p1b-${rid}`)]);
  rmSync(join(RUN_BASE, rid), { recursive: true, force: true });
  rmSync(join(EXEC_BASE, rid), { recursive: true, force: true });
  rmSync(join(CODE_BASE, rid), { recursive: true, force: true });
}
