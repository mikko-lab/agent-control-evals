/**
 * P1b environment check and host setup (decisions, "Isolation and privileges"). The check runs before any case; a
 * failed check makes every case of the run a technical error (exit 2). Nothing here changes the host's general
 * security settings: the only host changes are the three system users (host setup) and loading the netem qdisc module.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunConfig } from './config';
import { cgroupRoot, ids, sh, spawnAs, tryShell } from './orchestrator';

export interface EnvCheck { ok: boolean; checks: { name: string; ok: boolean; detail: string }[]; facts: Record<string, string> }

export function setupHost(config: RunConfig): string[] {
  const done: string[] = [];
  for (const u of [config.users.executor, config.users.doubles, config.users.observer]) {
    if (tryShell('id', ['-u', u]).ok) { done.push(`${u} exists`); continue; }
    sh('useradd', ['--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--user-group', u]);
    done.push(`${u} created`);
  }
  return done;
}

/** `needsNetem`: a case in scope has a harness delay element (always true for the full P1b profile). */
export async function envCheck(config: RunConfig, needsNetem = true): Promise<EnvCheck> {
  const checks: EnvCheck['checks'] = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  const facts: Record<string, string> = {
    kernel: tryShell('uname', ['-r']).out.trim(), node: process.version, platform: process.platform,
    apparmor_restrict_unprivileged_userns: tryShell('cat', ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns']).out.trim(),
    os: tryShell('sh', ['-c', '. /etc/os-release && echo "$PRETTY_NAME"']).out.trim(),
  };
  check('root', process.getuid?.() === 0, `uid ${process.getuid?.()}`);
  for (const tool of ['ip', 'tc', 'iptables', 'iptables-save', 'iptables-restore', 'nsenter', 'unshare', 'setpriv', 'mount', 'mkfifo', 'sysctl']) check(`tool ${tool}`, tryShell('sh', ['-c', `command -v ${tool}`]).ok);
  const users = [config.users.executor, config.users.doubles, config.users.observer];
  const uids: number[] = [];
  for (const u of users) {
    const r = tryShell('id', [u]);
    if (!r.ok) { check(`user ${u}`, false, 'missing'); continue; }
    const id = ids(u);
    uids.push(id.uid);
    const groups = tryShell('id', ['-Gn', u]).out.trim().split(/\s+/);
    check(`user ${u}`, id.uid !== 0 && id.gid !== 0 && groups.length === 1 && !groups.some(g => ['root', 'sudo', 'admin', 'adm', 'wheel', 'docker', 'lxd'].includes(g)), `uid ${id.uid}, groups ${groups.join(',')}`);
    const sudo = spawnSync('sudo', ['-n', '-l', '-U', u], { encoding: 'utf8' });
    check(`user ${u} has no sudo rights`, sudo.error !== undefined || /not allowed|is not allowed to run sudo/.test(`${sudo.stdout}${sudo.stderr}`) || sudo.status !== 0, `${(sudo.stdout || sudo.stderr || '').trim().slice(0, 200)}`);
  }
  check('users distinct', new Set(uids).size === users.length);
  const cg = cgroupRoot();
  check('cgroup v2 mounted', cg !== null, cg ?? '');
  if (cg) {
    const test = join(cg, `ea-p1b-envcheck-${process.pid}`);
    try { mkdirSync(test); check('cgroup v2 leaf with cgroup.kill and cgroup.events', existsSync(join(test, 'cgroup.kill')) && existsSync(join(test, 'cgroup.events'))); rmdirSync(test); } catch (e) { check('cgroup v2 leaf with cgroup.kill and cgroup.events', false, String(e)); }
  }
  mkdirSync('/run/ea', { recursive: true, mode: 0o755 });
  tryShell('modprobe', ['sch_netem']);
  const ns = `eaenv${process.pid}`;
  const netns = tryShell('ip', ['netns', 'add', ns]);
  check('network namespace', netns.ok, netns.out.trim());
  if (netns.ok) {
    tryShell('ip', ['-n', ns, 'link', 'set', 'lo', 'up']);
    const veth = tryShell('ip', ['-n', ns, 'link', 'add', 'eatesta', 'type', 'veth', 'peer', 'name', 'eatestb']);
    check('veth', veth.ok, veth.out.trim());
    check('iptables with conntrack in a namespace', tryShell('ip', ['netns', 'exec', ns, 'iptables', '-A', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT']).ok);
    const netem = tryShell('ip', ['netns', 'exec', ns, 'tc', 'qdisc', 'add', 'dev', 'lo', 'root', 'netem', 'delay', '10ms']);
    if (needsNetem || netem.ok) check('tc netem', netem.ok, netem.out.trim());
    else facts.netem = `not available and not needed by the cases in scope: ${netem.out.trim()}`;
    for (const u of users) {
      const p = spawnAs({ ns, user: ids(u), argv: [process.execPath, '-e', 'process.exit(require("node:os").userInfo().uid === Number(process.argv[1]) ? 0 : 1)', String(ids(u).uid)], hide: '/run/ea' });
      const code = await new Promise<number | null>(r => p.on('exit', c => r(c)));
      check(`node runs as ${u} without privileges`, code === 0, `exit ${code}`);
    }
    tryShell('ip', ['netns', 'del', ns]);
  }
  return { ok: checks.every(c => c.ok), checks, facts };
}
