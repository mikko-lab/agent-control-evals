/**
 * P1b executor: hosts the guard (reference or XM mutant) for one case. Runs as the executor user E in the guard
 * namespace (loopback only), inside the case cgroup and a mount namespace without the harness's files. The orchestrator
 * launches it under Node's permission model with child-process and worker creation denied, so the guard cannot create
 * any descendant process (decisions, "Executor quiescence"); the executor reports that at startup.
 *
 *   node --permission --allow-fs-read=* executor.js CONFIG.json
 *
 * Channels (decisions, "Channels to the executor"):
 * - stdin: commands from the driver, relayed by the root orchestrator: { type: 'attempt', request }, { type: 'cancel', attempt },
 *   { type: 'end' };
 * - stdout: { type: 'answer', attempt, decision, status } and { type: 'event', event, attempt, detail };
 * - fd 3: the closure signal FIFO, opened read-only: { type: 'closure', fence_id, attempts }.
 *
 * Network identity is NOT guard-controllable. The forwarding right is bound to the attempt the harness dispatched: the
 * executor captures that attempt's id and routes every `env.forward(...)` through that attempt's own forwarder, whatever
 * id the guard puts in the request it hands to `forward`. The binding is carried across the guard's async handling (and
 * its deferred, signal-triggered sends) by an AsyncLocalStorage store, so overlapping attempts never cross identities.
 * The hook holds the attempt before any decision and any forward until the harness cancels it after the driver's
 * timeout; a cancelled attempt never continues.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** Regression injections of the environment (never set in a profile run). */
  inject: { linger_ms: number; guard_per_attempt: boolean; spawn_child: boolean };
}
type Guard = { handle(a: AttemptRequest): Promise<{ decision: string; status: number | null }> };
type Out = (m: Record<string, unknown>) => void;

/**
 * The forwarding right bound to the attempt the harness dispatched. Module-private on purpose: it is never exported, so
 * the in-process guard has no reference to it and cannot open a binding for an identity it was not dispatched. A guard
 * that creates its own AsyncLocalStorage cannot change this one. (A guard that executes arbitrary code to reach another
 * forwarder socket directly is outside this boundary; see decisions.md, "Per-attempt identity", on the trust boundary.)
 */
const forwardBinding = new AsyncLocalStorage<string>();

export interface Executor {
  env: { timing: ExecutorConfig['timing']; event: (e: string, a: string | null, d: unknown) => void; forward: (a: AttemptRequest) => Promise<{ status: number }>; afterSignal: (attempt: string, delayMs: number, fn: () => void) => void };
  /** Runs one dispatched attempt with the forwarding right bound to its id, whatever the guard later asks to forward. */
  dispatch: (request: AttemptRequest, guard: Guard) => Promise<void>;
  deliverSignal: (fenceId: string, attempts: string[]) => void;
  refAll: () => void;
}

/** Builds the executor's environment and dispatch over a given output sink. Exposed for component tests. */
export function createExecutor(cfg: ExecutorConfig, out: Out): Executor {
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
        if (m.error) out({ type: 'event', event: 'forward_rejected', attempt: null, detail: { error: String(m.error) } });
        w?.({ status: typeof m.status === 'number' ? m.status : -1 });
      }
    });
    socket.on('error', () => { for (const w of cc.waiting.values()) w({ status: -1 }); cc.waiting.clear(); });
    socket.unref();
    conns.set(path, c);
    return c;
  };
  let seq = 0;
  const pendingAfterSignal: { attempt: string; delayMs: number; fn: () => void }[] = [];
  const forward = (a: AttemptRequest) => new Promise<{ status: number }>(resolve => {
    // The identity is the dispatched attempt's, never the id the guard put in the request.
    const boundId = forwardBinding.getStore();
    if (boundId === undefined) { out({ type: 'event', event: 'forward_without_attempt', attempt: null, detail: { requested: a.id } }); resolve({ status: -1 }); return; }
    const path = cfg.forwarders[boundId];
    if (!path) { out({ type: 'event', event: 'forward_no_forwarder', attempt: boundId, detail: null }); resolve({ status: -1 }); return; }
    const c = conn(path);
    const id = `${boundId}#${++seq}`;
    if (inFlight++ === 0) for (const x of conns.values()) x.socket.ref();
    c.waiting.set(id, r => { if (--inFlight === 0) for (const x of conns.values()) x.socket.unref(); resolve(r); });
    c.socket.write(JSON.stringify({ op: 'send', id, attempt: boundId, request: a }) + '\n');
  });
  const env: Executor['env'] = {
    timing: cfg.timing,
    event: (event, attempt, detail) => out({ type: 'event', event, attempt, detail }),
    forward,
    afterSignal: (_attempt, delayMs, fn) => {
      // The deferred send keeps the dispatching attempt's identity, taken only from the active binding. The id the guard
      // passes is never used: a deferred send registered outside a dispatched attempt (for example from the guard's
      // own initialization) has no identity and is refused, so it cannot borrow one.
      const boundId = forwardBinding.getStore();
      if (boundId === undefined) { out({ type: 'event', event: 'after_signal_without_attempt', attempt: null, detail: { requested: _attempt } }); return; }
      pendingAfterSignal.push({ attempt: boundId, delayMs, fn: () => forwardBinding.run(boundId, fn) });
    },
  };
  return {
    env,
    dispatch: (request, guard) => forwardBinding.run(request.id, () => guard.handle(request)).then(
      r => out({ type: 'answer', attempt: request.id, decision: r.decision, status: r.status }),
      e => out({ type: 'event', event: 'guard_error', attempt: request.id, detail: { error: String(e) } }),
    ),
    deliverSignal: (fenceId, attempts) => {
      out({ type: 'event', event: 'signal_received', attempt: null, detail: { fence_id: fenceId, attempts } });
      for (const p of pendingAfterSignal.filter(x => attempts.includes(x.attempt))) {
        pendingAfterSignal.splice(pendingAfterSignal.indexOf(p), 1);
        setTimeout(p.fn, p.delayMs);
      }
    },
    refAll: () => { for (const p of new Set(Object.values(cfg.forwarders))) conn(p); },
  };
}

const out: Out = m => process.stdout.write(JSON.stringify(m) + '\n');

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
  // Report the descendant-creation prevention the orchestrator is expected to have put in place (decisions: executor
  // quiescence covers the whole process tree because no descendant process can be created). The run validity layer
  // fails the case if this is not confirmed.
  const perm = (process as unknown as { permission?: { has(s: string): boolean } }).permission;
  out({ type: 'event', event: 'env_guard', attempt: null, detail: { child_process_denied: !!perm && !perm.has('child'), worker_denied: !!perm && !perm.has('worker') } });
  // Regression injection only: a guard that tries to create a descendant process. The permission model must deny it.
  if (cfg.inject.spawn_child) {
    try { (require('node:child_process') as typeof import('node:child_process')).spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']); out({ type: 'event', event: 'descendant_creation_allowed', attempt: null, detail: null }); }
    catch (e) { out({ type: 'event', event: 'descendant_creation_denied', attempt: null, detail: { code: (e as NodeJS.ErrnoException).code } }); }
  }

  const ex = createExecutor(cfg, out);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const create = (): Guard => require(cfg.guard_path)(cfg.policy, ex.env);
  const shared = create();
  const guardFor = (): Guard => cfg.inject.guard_per_attempt ? create() : shared;
  if (cfg.inject.linger_ms > 0) setTimeout(() => { /* injected: keeps the executor from quiescing */ }, cfg.inject.linger_ms);
  const held = new Map<string, () => void>();
  ex.refAll();

  lines(process.stdin, msg => {
    if (msg.type === 'attempt') {
      const a = msg.request as AttemptRequest;
      if (cfg.hooks[a.id] === 'hold_before_forward') {
        out({ type: 'event', event: 'hook_holding', attempt: a.id, detail: null });
        held.set(a.id, () => out({ type: 'event', event: 'hook_cancelled', attempt: a.id, detail: null }));
        return;
      }
      void ex.dispatch(a, guardFor());
    } else if (msg.type === 'cancel') {
      const c = held.get(String(msg.attempt)); held.delete(String(msg.attempt));
      if (c) c(); else out({ type: 'event', event: 'cancel_without_hold', attempt: String(msg.attempt), detail: null });
    } else if (msg.type !== 'end') out({ type: 'event', event: 'protocol_error', attempt: null, detail: { type: msg.type } });
  }, () => { process.stdin.destroy(); });

  const signal = new Socket({ fd: 3, readable: true, writable: false });
  lines(signal, msg => {
    if (msg.type !== 'closure') return;
    ex.deliverSignal(String(msg.fence_id), Array.isArray(msg.attempts) ? msg.attempts.map(String) : []);
  }, () => { signal.destroy(); });
}

if (require.main === module) void main();
