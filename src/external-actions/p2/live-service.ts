/** Child processes only. Controller supplies a literal, isolated topology. No OS DNS. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, Server } from 'node:http';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { resolveEndpoint, parseUrl, resolverDouble } from './routes';
import { Event, eventHash, ips, ServiceConfig } from './live-model';

export async function service(cfg: ServiceConfig) {
  let seq = 0, prev = '0'.repeat(64), active = 0;
  const records: string[] = [], sockets = new Set<Socket>();
  const log = (kind: string, data: Record<string, unknown>) => {
    const base = { run: cfg.run, case: cfg.case, attempt: cfg.attempt, service: cfg.role, seq: seq++, prev, kind, data };
    const e: Event = { ...base, hash: eventHash(base) }; prev = e.hash;
    if (cfg.role === 'e') process.stdout.write(JSON.stringify(e) + '\n');
    else appendFileSync(join(cfg.directory, 'journal.jsonl'), JSON.stringify(e) + '\n', { mode: 0o640 });
  };
  const headers = { 'x-run': cfg.run, 'x-case': cfg.case, 'x-attempt': cfg.attempt };
  const send = (address: string, path: string, body: string): Promise<string> => new Promise((resolve, reject) => {
    if (!Object.values(ips).includes(address)) return reject(new Error('non-synthetic destination'));
    log('connect_attempt', { address, port: 8080, path, body });
    const req = request({ host: address, port: 8080, path, method: 'POST', agent: false, headers: { ...headers, 'content-length': Buffer.byteLength(body), connection: 'close' } }, res => {
      let result = ''; res.on('data', d => { result += d; });
      res.on('end', () => res.statusCode === 200 ? resolve(result) : reject(new Error(`HTTP ${res.statusCode}`)));
    });
    req.setTimeout(2000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject); req.end(body);
  });
  const resolve = async (raw: string) => {
    const u = parseUrl(raw), name = u.hostname.replace(/\.$/, '');
    let address: string | null = name;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(name)) address = JSON.parse(await send(ips.r, '/resolve', JSON.stringify({ name }))).address;
    return resolveEndpoint(raw, () => address);
  };
  if (cfg.role === 'e') {
    const p = cfg.proposal, outer = parseUrl(p.url), proxy = outer.hostname === 'relay.test';
    const endpoint = await resolve(proxy ? p.final_url! : p.url);
    let allowed = endpoint?.recipient === 'P';
    if (endpoint && cfg.guard === 'direct-ip-allow' && /^\d+\.\d+\.\d+\.\d+$/.test(outer.hostname)) allowed = true;
    if (endpoint && cfg.guard === 'alias-allow' && outer.hostname.endsWith('-alias.test')) allowed = true;
    if (endpoint && cfg.guard === 'proxy-final-unchecked' && proxy) allowed = true;
    if (cfg.guard === 'deny-all') allowed = false;
    if (endpoint && (allowed || cfg.guard === 'deny-after-send')) {
      if (proxy) await send(ips.x, '/submit', JSON.stringify({ final_url: p.final_url, body: p.body }));
      else await send(endpoint.address, '/submit', p.body);
    }
    log('decision', { decision: cfg.guard === 'deny-after-send' ? 'DENY' : allowed ? 'ALLOW' : 'DENY' });
    if (cfg.inject === 'linger-executor') setInterval(() => {}, 1000);
    return;
  }
  writeFileSync(join(cfg.directory, 'journal.jsonl'), '', { mode: 0o640, flag: 'wx' });
  const srv: Server = createServer(async (req, res) => {
    active++;
    try {
      let body = '';
      for await (const d of req) { body += d; if (Buffer.byteLength(body) > 8192) throw new Error('body limit'); }
      const peer = req.socket.remoteAddress;
      if (req.headers['x-run'] !== cfg.run || req.headers['x-case'] !== cfg.case || req.headers['x-attempt'] !== cfg.attempt) throw new Error('identity mismatch');
      log('request', { peer, path: req.url, body, method: req.method });
      if (req.method !== 'POST') throw new Error('method');
      let result = '{}';
      if (cfg.role === 'r') {
        if (req.url !== '/resolve') throw new Error('resolver path');
        const name = JSON.parse(body).name;
        const address = resolverDouble(cfg.answers).resolve(name);
        log('answer', { name, address }); result = JSON.stringify({ address });
      } else if (cfg.role === 'x') {
        if (req.url !== '/submit') throw new Error('proxy path');
        const p = JSON.parse(body);
        const endpoint = await resolve(p.final_url);
        if (!endpoint || typeof p.body !== 'string') throw new Error('proxy target');
        await send(endpoint.address, '/submit', p.body);
      } else {
        if (req.url !== '/submit') throw new Error('recipient path');
        records.push(body); log('stored', { body, peer, address: ips[cfg.role] });
      }
      res.writeHead(200); res.end(result);
    } catch (e) { log('error', { message: String(e) }); res.writeHead(400); res.end(); }
    finally { active--; }
  });
  srv.on('connection', socket => {
    sockets.add(socket); log('connection', { peer: socket.remoteAddress, address: socket.localAddress });
    socket.on('close', () => sockets.delete(socket));
  });
  srv.requestTimeout = 3000; srv.headersTimeout = 3000;
  await new Promise<void>((ok, fail) => { srv.once('error', fail); srv.listen(8080, ips[cfg.role], ok); });
  process.stdout.write('READY\n');
  process.once('SIGTERM', () => {
    srv.close(() => {
      // close callback can precede the final socket close event by one tick.
      const drain = () => {
        if (active || sockets.size) { setTimeout(drain, 10); return; }
        const state = { records, open: sockets.size, active };
        log('closed', state);
        writeFileSync(join(cfg.directory, 'state.json'), JSON.stringify(state), { mode: 0o640, flag: 'wx' });
      };
      drain();
    });
  });
}
if (require.main === module) service(JSON.parse(readFileSync(process.argv[2], 'utf8'))).catch(e => { console.error(String(e)); process.exitCode = 2; });
