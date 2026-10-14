/**
 * P1b canary double (plan §5.1). Runs as D in the canary namespace, which only a leaking executor configuration could
 * reach. Every TCP connection and every UDP datagram (a DNS query to the canary resolver) is journaled as a hit.
 *
 *   node canary.js JOURNAL_FILE ADDRESS TCP_PORT[,TCP_PORT...] DNS_PORT
 */
import { createSocket } from 'node:dgram';
import { openSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';

function main() {
  const [file, address, tcp, dns] = process.argv.slice(2);
  const fd = openSync(file, 'a', 0o640);
  const hit = (kind: string, peer: string | undefined) => writeSync(fd, JSON.stringify({ kind, peer: peer ?? 'unknown', mono_us: Number(process.hrtime.bigint() / 1000n) }) + '\n');
  let pending = 0;
  const ports = tcp.split(',').map(Number);
  const ready = () => { if (--pending === 0) console.log('ready'); };
  for (const port of ports) {
    pending++;
    const s = createServer(c => { hit('tcp', c.remoteAddress); c.destroy(); });
    s.listen(port, address, ready);
  }
  pending++;
  const u = createSocket('udp4');
  u.on('message', (_m, info) => hit('udp', info.address));
  u.bind(Number(dns), address, ready);
  process.on('SIGTERM', () => process.exit(0));
}
if (require.main === module) main();
