/**
 * P1b netem backlog reader (decisions D10, "Recipient quiescence and tc netem"). Runs as the harness reader H in the
 * doubles' namespace and answers, over a Unix socket in H's own directory, the summed queue length of every qdisc
 * there. Reading qdisc statistics needs no privilege.
 *
 *   node netem-reader.js SOCKET
 *   request: any line -> { ok, backlog_packets, netem: [{ dev, delay_us }] }
 */
import { execFile } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:net';

interface Qdisc { kind: string; dev: string; qlen?: number; options?: { delay?: { delay?: number } } }
export function backlog(cb: (r: { ok: boolean; backlog_packets: number | null; netem: { dev: string; delay_us: number | null }[]; error?: string }) => void) {
  execFile('tc', ['-s', '-j', 'qdisc', 'show'], { timeout: 2000 }, (err, stdout) => {
    if (err) return cb({ ok: false, backlog_packets: null, netem: [], error: String(err) });
    try {
      const list = JSON.parse(stdout) as Qdisc[];
      const netem = list.filter(q => q.kind === 'netem').map(q => ({ dev: q.dev, delay_us: q.options?.delay?.delay !== undefined ? Math.round(q.options.delay.delay * 1e6) : null }));
      cb({ ok: true, backlog_packets: list.reduce((n, q) => n + (q.qlen ?? 0), 0), netem });
    } catch (error) { cb({ ok: false, backlog_packets: null, netem: [], error: String(error) }); }
  });
}

function main() {
  const sock = process.argv[2];
  const s = createServer(c => {
    let buf = '';
    c.on('data', d => {
      buf += d.toString('utf8');
      while (buf.includes('\n')) { buf = buf.slice(buf.indexOf('\n') + 1); backlog(r => c.write(JSON.stringify(r) + '\n')); }
    });
    c.on('error', () => { /* reader gone */ });
  });
  s.listen(sock, () => { chmodSync(sock, 0o600); console.log('ready'); });
  process.on('SIGTERM', () => process.exit(0));
}
if (require.main === module) main();
