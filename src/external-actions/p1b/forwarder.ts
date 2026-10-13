/**
 * P1b egress forwarder of one network identity (decisions, "Per-attempt identity"). Runs as the executor user E in its
 * identity namespace, inside the case cgroup. The guard hands it the requests it forwards; the forwarder sends them
 * from its namespace, so its source address is the identity the harness assigned. It cannot choose another one.
 *
 *   node forwarder.js SOCKET
 *   request lines: { op: 'send', id, request: AttemptRequest } -> { id, status } | { id, error }
 *
 * Requests that name the same connection label and ask to keep it open reuse one keep-alive connection. The forwarder
 * accepts one client (the guard) and exits on its own once that client has gone and no request is in flight.
 */
import { chmodSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { connect, createServer, Socket } from 'node:net';
import type { AttemptRequest } from './config';

function main() {
  const sock = process.argv[2];
  const agents = new Map<string, Agent>();
  const server = createServer(client => {
    server.close();
    let buf = '';
    client.on('data', d => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg: { op: string; id: string; request: AttemptRequest };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.op !== 'send') continue;
        send(msg.request, agents, (r: { status: number } | { error: string }) => { if (!client.destroyed) client.write(JSON.stringify({ id: msg.id, ...r }) + '\n'); });
      }
    });
    client.on('error', () => { /* the guard went away */ });
  });
  server.listen(sock, () => { chmodSync(sock, 0o600); console.log('ready'); });
}

function send(r: AttemptRequest, agents: Map<string, Agent>, done: (x: { status: number } | { error: string }) => void) {
  if (r.path === null) {
    // A connection without a request: connect, then close.
    const s: Socket = connect({ host: r.address, port: r.port }, () => { s.end(); });
    s.on('close', () => done({ status: 0 }));
    s.on('error', e => done({ error: String(e) }));
    return;
  }
  let agent = agents.get(r.connection);
  if (!agent) { agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.set(r.connection, agent); }
  const body = Buffer.from(JSON.stringify(r.fields ?? {}), 'utf8');
  const req = httpRequest({
    host: r.address, port: r.port, method: r.method ?? 'POST', path: r.path, agent,
    headers: { host: r.host, 'content-type': 'application/json', 'content-length': String(body.length), connection: r.keep_open ? 'keep-alive' : 'close' },
  }, res => {
    res.resume();
    res.on('end', () => {
      if (!r.keep_open) { agent!.destroy(); agents.delete(r.connection); }
      done({ status: res.statusCode ?? 0 });
    });
  });
  req.on('error', e => { agent!.destroy(); agents.delete(r.connection); done({ error: String(e) }); });
  req.end(body);
}

if (require.main === module) main();
