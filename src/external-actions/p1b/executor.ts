/**
 * P1b executor: hosts the guard (reference or XM mutant) for one case. Runs as the executor user E in the guard
 * namespace (loopback only), inside the case cgroup and a mount namespace without the harness's files.
 *
 *   node executor.js CONFIG.json
 *
 * Channels (decisions, "Channels to the executor"):
 * - stdin: commands from the driver, relayed by the root orchestrator: { type: 'attempt', request }, { type: 'cancel', attempt },
 *   { type: 'end' };
 * - stdout: { type: 'answer', attempt, decision, status } and { type: 'event', event, attempt, detail };
 * - fd 3: the closure signal FIFO, opened read-only: { type: 'closure', fence_id, attempts }.
 *
 * The environment around the guard provides forwarding through the attempt's identity forwarder, the closure signal
 * and the `retry-after-unsent` hook. The hook holds the attempt at the entry of the guard's handling, before any
 * decision and any forward, until the harness cancels it after the driver's timeout; a cancelled attempt never
 * continues. The process exits on its own once both channels are closed and no forward or timer is pending.
 */
import { readFileSync } from 'node:fs';
import { connect, Socket } from 'node:net';
import type { AttemptRequest } from './config';

export interface ExecutorConfig {
  guard_path: string;
  policy: { grants: unknown[]; forms: unknown[] };
  /** Forwarder socket of each attempt's network identity. */
  forwarders: Record<string, string>;
  hooks: Record<string, 'hold_before_forward'>;
  timing: { xm13a_delay_ms: number; xm13b_delay_ms: number };
  /** Regression injections of the environment (never set in a profile run): a timer that keeps the executor alive, and a fresh guard per attempt. */
  inject: { linger_ms: number; guard_per_attempt: boolean };
}
type Guard = { handle(a: AttemptRequest): Promise<{ decision: string; status: number | null }> };

const out = (m: Record<string, unknown>) => process.stdout.write(JSON.stringify(m) + '\n');

function lines(s: NodeJS.ReadableStream | Socket, on: (msg: Record<string, unknown>) => void, end: () => void) {
  let buf = '';
  s.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { on(JSON.parse(line)); } catch { out({ type: 'event', event: 'protocol_error', attempt: null, detail: { line: line.slice(0, 200) } }); }
    }
  });
  s.on('end', end);
  s.on('error', end);
}

async function main() {
  const cfg: ExecutorConfig = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  // Forwarder connections, one per identity socket; referenced only while a forward is in flight.
  const conns = new Map<string, { socket: Socket; waiting: Map<string, (r: { status: number }) => void>; buf: string }>();
  let inFlight = 0;
  const conn = (path: string) => {
    let c = conns.get(path);
    if (c) return c;
    const socket = connect(path);
    c = { socket, waiting: new Map(), buf: '' };
    const cc = c;
    socket.on('data', (d: Buffer) => {
      cc.buf += d.toString('utf8');
      let i: number;
      while ((i = cc.buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(cc.buf.slice(0, i)); cc.buf = cc.buf.slice(i + 1);
        const w = cc.waiting.get(m.id); cc.waiting.delete(m.id);
        w?.({ status: typeof m.status === 'number' ? m.status : -1 });
      }
    });
    socket.on('error', () => { for (const w of cc.waiting.values()) w({ status: -1 }); cc.waiting.clear(); });
    socket.unref();
    conns.set(path, c);
    return c;
  };
  let seq = 0;
  const env = {
    timing: cfg.timing,
    event: (event: string, attempt: string | null, detail: unknown) => out({ type: 'event', event, attempt, detail }),
    forward: (a: AttemptRequest) => new Promise<{ status: number }>(resolve => {
      const path = cfg.forwarders[a.id];
      if (!path) { resolve({ status: -1 }); return; }
      const c = conn(path);
      const id = `${a.id}#${++seq}`;
      if (inFlight++ === 0) for (const x of conns.values()) x.socket.ref();
      c.waiting.set(id, r => { if (--inFlight === 0) for (const x of conns.values()) x.socket.unref(); resolve(r); });
      c.socket.write(JSON.stringify({ op: 'send', id, request: a }) + '\n');
    }),
    afterSignal: (attempt: string, delayMs: number, fn: () => void) => { pendingAfterSignal.push({ attempt, delayMs, fn }); },
  };
  const pendingAfterSignal: { attempt: string; delayMs: number; fn: () => void }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const create = (): Guard => require(cfg.guard_path)(cfg.policy, env);
  const shared = create();
  const guardFor = (): Guard => cfg.inject.guard_per_attempt ? create() : shared;
  if (cfg.inject.linger_ms > 0) setTimeout(() => { /* injected: keeps the executor from quiescing */ }, cfg.inject.linger_ms);
  const held = new Map<string, () => void>();
  // Every forwarder serves exactly one client and exits once it has gone, so each one is connected at the start.
  for (const p of new Set(Object.values(cfg.forwarders))) conn(p);

  lines(process.stdin, msg => {
    if (msg.type === 'attempt') {
      const a = msg.request as AttemptRequest;
      const run = () => guardFor().handle(a).then(r => out({ type: 'answer', attempt: a.id, decision: r.decision, status: r.status }), e => out({ type: 'event', event: 'guard_error', attempt: a.id, detail: { error: String(e) } }));
      if (cfg.hooks[a.id] === 'hold_before_forward') {
        out({ type: 'event', event: 'hook_holding', attempt: a.id, detail: null });
        held.set(a.id, () => out({ type: 'event', event: 'hook_cancelled', attempt: a.id, detail: null }));
        return;
      }
      void run();
    } else if (msg.type === 'cancel') {
      const c = held.get(String(msg.attempt)); held.delete(String(msg.attempt));
      if (c) c(); else out({ type: 'event', event: 'cancel_without_hold', attempt: String(msg.attempt), detail: null });
    } else if (msg.type !== 'end') out({ type: 'event', event: 'protocol_error', attempt: null, detail: { type: msg.type } });
  }, () => { process.stdin.destroy(); });

  const signal = new Socket({ fd: 3, readable: true, writable: false });
  lines(signal, msg => {
    if (msg.type !== 'closure') return;
    const attempts = Array.isArray(msg.attempts) ? msg.attempts.map(String) : [];
    out({ type: 'event', event: 'signal_received', attempt: null, detail: { fence_id: msg.fence_id, attempts } });
    for (const p of pendingAfterSignal.filter(x => attempts.includes(x.attempt))) {
      pendingAfterSignal.splice(pendingAfterSignal.indexOf(p), 1);
      setTimeout(p.fn, p.delayMs);
    }
  }, () => { signal.destroy(); });
}

if (require.main === module) void main();
