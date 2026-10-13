/**
 * P1b isolation probe (plan §5.1, decisions "Canary probes"). Runs as the executor user E in one executor namespace,
 * before the case. Every probe must fail: a probe that connects or gets an answer is an isolation failure.
 *
 *   node probe.js JSON   with { hidden_paths, canary, canary_tcp_port, canary_dns_port, no_route, filtered: { address, port }, timeout_ms }
 *   prints { probes: [{ name, target, blocked, detail }] }
 */
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';

interface Spec { hidden_paths: string[]; canary: string; canary_tcp_port: number; canary_dns_port: number; no_route: string; filtered: { address: string; port: number }; timeout_ms: number }
type Result = { name: string; target: string; blocked: boolean; detail: string };

function tcp(name: string, host: string, port: number, timeout: number): Promise<Result> {
  return new Promise(resolve => {
    const target = `${host}:${port}/tcp`;
    const s = connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve({ name, target, blocked: true, detail: 'timeout' }); }, timeout);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve({ name, target, blocked: false, detail: 'connected' }); });
    // A refused connection reached its target (it was answered), so it is not blocked.
    s.on('error', e => { clearTimeout(t); const code = (e as NodeJS.ErrnoException).code ?? String(e); resolve({ name, target, blocked: code !== 'ECONNREFUSED' && code !== 'ECONNRESET', detail: code }); });
  });
}

/** A minimal DNS query (A record for canary.test). */
function dns(name: string, host: string, port: number, timeout: number): Promise<Result> {
  return new Promise(resolve => {
    const target = `${host}:${port}/udp`;
    const q = Buffer.concat([Buffer.from('ea10010000010000000000000663616e61727904746573740000010001', 'hex')]);
    const u = createSocket('udp4');
    const finish = (r: Result) => { clearTimeout(t); try { u.close(); } catch { /* closed */ } resolve(r); };
    const t = setTimeout(() => finish({ name, target, blocked: true, detail: 'no answer' }), timeout);
    u.on('message', () => finish({ name, target, blocked: false, detail: 'answer' }));
    u.on('error', e => finish({ name, target, blocked: true, detail: (e as NodeJS.ErrnoException).code ?? String(e) }));
    u.send(q, port, host, e => { if (e) finish({ name, target, blocked: true, detail: (e as NodeJS.ErrnoException).code ?? String(e) }); });
  });
}

async function main() {
  const s: Spec = JSON.parse(process.argv[2]);
  const probes = [
    await tcp('canary_tcp', s.canary, s.canary_tcp_port, s.timeout_ms),
    await dns('canary_dns', s.canary, s.canary_dns_port, s.timeout_ms),
    await tcp('no_route', s.no_route, 443, s.timeout_ms),
    await tcp('filtered_port', s.filtered.address, s.filtered.port, s.timeout_ms),
    // The journals, control sockets and harness IPC must not be visible in the executor's mount namespace.
    ...s.hidden_paths.map(p => ({ name: 'observation_channel_hidden', target: p, blocked: !existsSync(p), detail: existsSync(p) ? 'visible' : 'not visible' })),
  ];
  process.stdout.write(JSON.stringify({ probes }) + '\n');
}
if (require.main === module) void main();
