import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalJson } from '../../util/canonical-json';
import { routeCases } from './corpus';
import { digest, H, ips, LiveCase, LiveRun, ProcessResult, Role, roles, ServiceConfig, uids } from './live-model';
import { GuardMode, GUARD_MUTANTS } from './routes';
import { evaluateLive } from './live-evaluate';
import { filter, configurationIssues } from './topology';

function sh(cmd: string, args: string[], input?: string) {
  return execFileSync(cmd, args, { encoding: 'utf8', input, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
interface Child { p: ChildProcess; stdout: string; stderr: string; result: ProcessResult | null; timedOut: boolean }
export async function linuxRun(out: string, guard: GuardMode, inject = ''): Promise<LiveRun> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Linux root required; no fallback');
  if (!['reference', ...GUARD_MUTANTS].includes(guard)) throw new Error('unknown guard');
  if (inject && !['linger-executor', 'channel-writable', 'missing-journal', 'foreign-observation', 'isolation-changed'].includes(inject)) throw new Error('unknown injection');
  out = resolve(out); mkdirSync(out, { recursive: false });
  const run: LiveRun = { format: 'external-action-p2-live-run/1', evidence_kind: 'local_recipient_observation', run_id: `p2-${randomBytes(6).toString('hex')}`, guard, node: process.version, platform: process.platform, cases: [] };
  const base = `/tmp/${run.run_id}`; mkdirSync(base, { mode: 0o755 });
  const version = Number(process.versions.node.split('.')[0]);
  if (![22, 24].includes(version)) throw new Error('live profile supports Node 22/24 only');
  const perm = version === 22 ? '--experimental-permission' : '--permission';
  const script = join(__dirname, 'live-service.js');
  for (const c of routeCases()) {
    const activeInjection = c.id === 'canonical-P' ? inject : '';
    const id = { run: run.run_id, case: c.id, attempt: 'a1' as const };
    const token = `p2${randomBytes(3).toString('hex')}`;
    const ns = (r: Role | 'b') => `${token}${r}`;
    const nsExec = (r: Role, cmd: string, args: string[], input?: string) => sh('ip', ['netns', 'exec', ns(r), cmd, ...args], input);
    const dir = join(base, c.id); mkdirSync(dir, { mode: 0o755 });
    const children: Child[] = [];
    let channelDiagnostic: Record<string, unknown> | null = null;
    const raw: LiveCase = { ...id, decision: 'UNKNOWN', events: { e: [], x: [], r: [], p: [], q: [] }, states: {}, processes: [], isolation: { before: '', after: '', before_hash: '', after_hash: '', probes: {}, channels_before: false, channels_after: false }, errors: [] };
    const roleDir = (r: Role) => join(dir, r);
    const asH = (path: string) => sh('setpriv', ['--reuid', String(H), '--regid', String(H), '--clear-groups', 'cat', path]);
    const snapshot = () => canonicalJson(Object.fromEntries([...roles, 'b' as const].map(r => {
      const get = (cmd: string, args: string[]) => sh('ip', ['netns', 'exec', ns(r), cmd, ...args]).split('\n').filter(l => !l.startsWith('#')).join('\n');
      return [r, { addresses: get('ip', ['addr']), routes: get('ip', ['route', 'show', 'table', 'all']), filter: get('iptables-save', []),
        ipv6: get('cat', ['/proc/sys/net/ipv6/conf/all/disable_ipv6']), forwarding: get('cat', ['/proc/sys/net/ipv4/ip_forward']),
        drops: get('iptables-save', ['-c']).split('\n').filter(l => / -j DROP$/.test(l)).join('\n') }];
    })));
    const channels = (final = false) => {
      try {
        return (['x', 'r', 'p', 'q'] as const).every(r => {
          const d = statSync(roleDir(r)), f = statSync(join(roleDir(r), 'journal.jsonl'));
          if (d.uid !== uids[r] || d.gid !== H || (d.mode & 0o7777) !== 0o2750 || f.uid !== uids[r] || f.gid !== H || (f.mode & 0o777) !== 0o640) return false;
          if (final) { const state = statSync(join(roleDir(r), 'state.json')); if (state.uid !== uids[r] || state.gid !== H || (state.mode & 0o777) !== 0o640) return false; }
          try { sh('setpriv', ['--reuid', String(uids.e), '--regid', String(uids.e), '--clear-groups', 'sh', '-c', 'test -r "$1" || test -w "$1"', 'probe', join(roleDir(r), 'journal.jsonl')]); return false; } catch { return true; }
        });
      } catch { return false; }
    };
    const start = (role: Role): Child => {
      const config: ServiceConfig = { ...id, role, directory: roleDir(role), proposal: c.proposal, answers: c.resolver_answers, guard, inject: activeInjection };
      const cfg = join(dir, `${role}.json`); writeFileSync(cfg, JSON.stringify(config), { mode: 0o644 });
      const argv = ['netns', 'exec', ns(role), 'setpriv', '--reuid', String(uids[role]), '--regid', String(uids[role]), '--clear-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', process.execPath, perm, '--allow-fs-read=*'];
      if (role !== 'e') argv.push(`--allow-fs-write=${roleDir(role)}`);
      argv.push(script, cfg);
      const p = spawn('ip', argv, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C' } });
      const child: Child = { p, stdout: '', stderr: '', result: null, timedOut: false }; children.push(child);
      p.stdout!.on('data', b => { child.stdout += b; }); p.stderr!.on('data', b => { child.stderr += b; });
      p.on('error', e => { raw.errors.push(String(e)); });
      p.on('close', (code, signal) => { child.result = { role, code, signal, timed_out: child.timedOut }; });
      return child;
    };
    const finish = async (child: Child, role: Role) => {
      const until = Date.now() + 10000;
      while (!child.result && Date.now() < until) await sleep(20);
      if (!child.result) {
        child.timedOut = true;
        try { process.kill(-child.p.pid!, 'SIGKILL'); } catch { /* already exited */ }
        await sleep(50);
        child.result = { role, code: null, signal: 'SIGKILL', timed_out: true };
      }
      raw.processes.push(child.result);
    };
    try {
      for (const r of [...roles, 'b' as const]) {
        sh('ip', ['netns', 'add', ns(r)]);
        // Docker mounts /proc/sys read-only. Remount only inside a fresh private
        // mount namespace already attached to this newly created network namespace.
        sh('ip', ['netns', 'exec', ns(r), 'unshare', '-m', '--propagation', 'private', 'sh', '-c',
          'mount -o remount,rw /proc/sys && sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 net.ipv4.ip_forward=0']);
      }
      sh('ip', ['-n', ns('b'), 'link', 'add', 'br0', 'type', 'bridge']); sh('ip', ['-n', ns('b'), 'link', 'set', 'br0', 'up']);
      for (const r of roles) {
        sh('ip', ['link', 'add', `${token}${r}v`, 'netns', ns(r), 'type', 'veth', 'peer', 'name', `${token}${r}b`, 'netns', ns('b')]);
        sh('ip', ['-n', ns('b'), 'link', 'set', `${token}${r}b`, 'master', 'br0']); sh('ip', ['-n', ns('b'), 'link', 'set', `${token}${r}b`, 'up']);
        sh('ip', ['-n', ns(r), 'addr', 'add', `${ips[r]}/24`, 'dev', `${token}${r}v`]); sh('ip', ['-n', ns(r), 'link', 'set', `${token}${r}v`, 'up']);
        nsExec(r, 'iptables-restore', [], filter(r));
        if (/default/.test(nsExec(r, 'ip', ['route', 'show', 'table', 'all']))) throw new Error('default route');
        // Kernel DROP evidence, not just a connection-refused response.
        const drops = () => nsExec(r, 'iptables-save', ['-c']).split('\n').filter(l => /-A OUTPUT -j DROP$/.test(l)).join('\n');
        const before = drops();
        nsExec(r, process.execPath, ['-e', "const s=require('node:net').connect({host:'10.88.0.254',port:8099});s.setTimeout(100,()=>{s.destroy();process.exit(0)});s.on('connect',()=>process.exit(2));s.on('error',()=>process.exit(3));"]);
        raw.isolation.probes[r] = drops() !== before;
        mkdirSync(roleDir(r), { mode: 0o2750 }); chownSync(roleDir(r), uids[r], H); chmodSync(roleDir(r), 0o2750);
      }
      const services: Partial<Record<Role, Child>> = {};
      for (const r of ['r', 'p', 'q', 'x'] as const) {
        services[r] = start(r);
        const until = Date.now() + 5000;
        while (!services[r]!.stdout.includes('READY') && !services[r]!.result && Date.now() < until) await sleep(20);
        if (!services[r]!.stdout.includes('READY')) throw new Error(`service ${r} startup: ${services[r]!.stderr}`);
      }
      if (activeInjection === 'channel-writable') {
        const modeBefore = statSync(roleDir('p')).mode & 0o7777;
        const channelsBeforeChange = channels();
        chmodSync(roleDir('p'), 0o2777);
        channelDiagnostic = { format: 'p2-channel-precheck/1', ...id, guard, injection: activeInjection,
          role: 'p', mode_before: modeBefore, mode_after: statSync(roleDir('p')).mode & 0o7777,
          channels_before_change: channelsBeforeChange, channels_after_change: channels(),
          precheck_rejected: false, executor_started: false };
      }
      raw.isolation.channels_before = channels();
      raw.isolation.before = snapshot(); raw.isolation.before_hash = digest(raw.isolation.before);
      raw.errors.push(...configurationIssues(raw.isolation.before));
      if (raw.errors.length) throw new Error('topology validation failed');
      if (!raw.isolation.channels_before || !roles.every(r => raw.isolation.probes[r])) {
        if (channelDiagnostic) channelDiagnostic.precheck_rejected = !raw.isolation.channels_before && roles.every(r => raw.isolation.probes[r]) && raw.errors.length === 0;
        throw new Error('isolation precheck failed');
      }
      if (channelDiagnostic) channelDiagnostic.executor_started = true;
      const executor = start('e'); await finish(executor, 'e');
      raw.events.e = executor.stdout.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      raw.decision = raw.events.e.find(e => e.kind === 'decision')?.data.decision as LiveCase['decision'] ?? 'UNKNOWN';
      for (const r of ['x', 'p', 'q', 'r'] as const) { services[r]!.p.kill('SIGTERM'); await finish(services[r]!, r); }
      for (const r of ['x', 'r', 'p', 'q'] as const) {
        raw.events[r] = asH(join(roleDir(r), 'journal.jsonl')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        try { raw.states[r] = JSON.parse(asH(join(roleDir(r), 'state.json'))); }
        catch { raw.states[r] = { records: [], open: 1, active: 1 }; raw.errors.push(`state_missing:${r}`); }
      }
      raw.isolation.channels_after = channels(true); raw.isolation.after = snapshot(); raw.isolation.after_hash = digest(raw.isolation.after);
      if (activeInjection === 'missing-journal') raw.events.p = [];
      if (activeInjection === 'foreign-observation' && raw.events.p[0]) raw.events.p[0].run = 'foreign';
      if (activeInjection === 'isolation-changed') raw.isolation.after += '\nINJECTED';
    } catch (e) { raw.errors.push(String(e)); }
    finally {
      for (const child of children) if (!child.result) { try { process.kill(-child.p.pid!, 'SIGKILL'); } catch { /* already gone */ } }
      writeFileSync(join(out, `${c.id}.diagnostics.json`), JSON.stringify(children.map(ch => ({ stdout: ch.stdout, stderr: ch.stderr, result: ch.result })), null, 2));
      for (const r of [...roles, 'b' as const]) try { sh('ip', ['netns', 'del', ns(r)]); } catch { /* partial setup */ }
      if (channelDiagnostic) writeFileSync(join(out, 'channel-precheck.json'), canonicalJson(channelDiagnostic) + '\n');
      run.cases.push(raw); writeFileSync(join(out, 'raw.json'), canonicalJson(run) + '\n');
    }
    if (raw.errors.length && !inject) break; // preserve failure; do not repeatedly attempt broken setup
  }
  try { writeFileSync(join(out, 'report.json'), canonicalJson(evaluateLive(run)) + '\n'); }
  catch (e) { writeFileSync(join(out, 'evaluation-error.txt'), String(e) + '\n'); }
  return run;
}
