/**
 * P1b recipient doubles P and Q (plan §5.1-§5.2, decisions "P1b decisions: Recipients"). Runs as the doubles user D in
 * the doubles' network namespace. Each recipient has its own listener, state, hash-chained journal file and control
 * socket. The doubles never deduplicate; content digests and logical ids are computed from the received body.
 *
 *   node doubles.js CONFIG.json
 *
 * Journal entries are appended synchronously to `<journal_dir>/<R>.jsonl`. Control requests (one JSON object per line):
 *   { op: 'fence', id } -> { ok, seq, state }       fence entry and the state at that point, atomically
 *   { op: 'state' }     -> { ok, journal_seq, state }
 *   { op: 'tracker' }   -> { ok, tracker }          open connections, running handlers, queued jobs, pending writes
 */
import { chmodSync, closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createNetServer, Socket } from 'node:net';
import { join } from 'node:path';
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { contentDigest, Entry, entryHash, FormDef, GENESIS, logicalId, Recipient, RecipientMode, RecipientState, Tracker } from '../spec/model';

export interface DoublesConfig {
  journal_dir: string;
  ctl_dir: string;
  recipients: Record<Recipient, {
    address: string; port: number; mode: RecipientMode; hold_first_submission_ms: number; deferred_persist_ms: number; forms: FormDef[];
    /** Regression injections (never set in a profile run): hold every response this long; write no journal file. */
    inject: { hold_all_responses_ms: number; no_journal: boolean };
  }>;
}

export const nowUs = (): number => Number(process.hrtime.bigint() / 1000n);
type Draft = Record<string, unknown> & { kind: Entry['kind'] };

class Recipient1 {
  state: RecipientState = { connections: 0, requests: 0, drafts: [], submissions: [] };
  tracker: Tracker = { open_connections: 0, running_handlers: 0, queued_jobs: 0, pending_writes: 0 };
  private seq = 0;
  private prev = GENESIS;
  private fd: number;
  private connIds = new WeakMap<Socket, { id: string; requests: number }>();
  private connCount = 0;
  private records = 0;
  private held = false;
  constructor(readonly id: Recipient, readonly cfg: DoublesConfig['recipients'][Recipient], journalDir: string) {
    this.fd = cfg.inject.no_journal ? openSync('/dev/null', 'a') : openSync(join(journalDir, `${id}.jsonl`), 'a', 0o640);
    if (!cfg.inject.no_journal) chmodSync(join(journalDir, `${id}.jsonl`), 0o640);
  }
  append(e: Draft): number {
    const draft = { ...e, mono_us: nowUs(), seq: this.seq, prev: this.prev } as unknown as Entry;
    const hash = entryHash(draft);
    const full = { ...draft, hash };
    writeSync(this.fd, canonicalJson(full) + '\n');
    this.prev = hash;
    return this.seq++;
  }
  get journalSeq(): number { return this.seq - 1; }
  stateDigest() { return sha256Hex(canonicalJson(this.state)); }
  snapshot(): RecipientState { return JSON.parse(JSON.stringify(this.state)); }
  close() { closeSync(this.fd); }

  onConnection(socket: Socket) {
    this.tracker.open_connections++;
    const id = `${this.id.toLowerCase()}-c${++this.connCount}`;
    this.connIds.set(socket, { id, requests: 0 });
    this.state.connections++;
    this.append({ kind: 'connection_accepted', peer: socket.remoteAddress ?? 'unknown', connection_id: id });
    socket.once('close', () => { this.tracker.open_connections--; });
  }

  onRequest(req: IncomingMessage, res: ServerResponse) {
    this.tracker.running_handlers++;
    let finished = false;
    const done = () => { if (!finished) { finished = true; this.tracker.running_handlers--; } };
    res.once('close', done);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try { this.handle(req, res, Buffer.concat(chunks)); } catch (error) { res.statusCode = 500; res.end(); console.error(String(error)); }
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const conn = this.connIds.get(req.socket)!;
    const m = /^\/forms\/([^/]+)\/(fill|submit|autosave)$/.exec(req.url ?? '');
    const form = m ? this.cfg.forms.find(f => f.form_id === m[1]) : undefined;
    let fields: Record<string, string> | null = null;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every(v => typeof v === 'string')) fields = parsed;
    } catch { /* not a form body */ }
    const kind = m && form && fields && req.method === 'POST' ? m[2] : null;
    const digest = kind && form && fields ? contentDigest(form, fields) : null;
    const actionClass = kind === 'fill' ? (form!.autosave ? 'autosave' : 'fill') : kind === 'submit' ? 'submit' : kind === 'autosave' ? 'autosave' : 'other';
    this.state.requests++;
    const reqSeq = this.append({
      kind: 'request_received', peer: req.socket.remoteAddress ?? 'unknown', connection_id: conn.id, request_index: conn.requests++,
      method: req.method ?? '', host: String(req.headers.host ?? ''), path: req.url ?? '', local_address: req.socket.localAddress ?? 'unknown',
      action_class: actionClass, content_digest: digest,
    });
    const send = (status: number) => { if (!res.destroyed) { res.statusCode = status; res.setHeader('content-length', '0'); res.end(); } };
    const reply = (status: number) => { if (this.cfg.inject.hold_all_responses_ms > 0) setTimeout(() => send(status), this.cfg.inject.hold_all_responses_ms); else send(status); };
    if (!kind || !form || !digest) return reply(400);
    if (kind === 'fill') {
      if (form.autosave) {
        const before = this.stateDigest();
        this.state.drafts = [...this.state.drafts.filter(d => d.form_id !== form.form_id), { form_id: form.form_id, digest }];
        this.append({ kind: 'draft_stored', request_seq: reqSeq, form_id: form.form_id, content_digest: digest, before_digest: before, after_digest: this.stateDigest() });
      }
      return reply(200);
    }
    const logical = logicalId(form.form_id, digest);
    const received = this.append({ kind: 'submit_received', request_seq: reqSeq, logical_id: logical, content_digest: digest });
    if (this.cfg.mode === 'failing') {
      this.append({ kind: 'submit_rejected', received_seq: received, reason: 'service_unavailable' });
      return reply(503);
    }
    const store = (deferred: boolean) => {
      const before = this.stateDigest();
      const record_id = `${this.id.toLowerCase()}-rec-${++this.records}`;
      this.state.submissions = [...this.state.submissions, { record_id, logical_id: logical, content_digest: digest }];
      this.append({ kind: 'submit_stored', received_seq: received, record_id, logical_id: logical, deferred, before_digest: before, after_digest: this.stateDigest() });
    };
    if (this.cfg.mode === 'deferred_persist') {
      // The response goes first; the record is stored by a background job after the response has been sent.
      this.tracker.queued_jobs++;
      res.once('finish', () => setTimeout(() => { store(true); this.tracker.queued_jobs--; }, this.cfg.deferred_persist_ms));
      return reply(202);
    }
    store(false);
    if (this.cfg.hold_first_submission_ms > 0 && !this.held) {
      this.held = true;
      setTimeout(() => reply(201), this.cfg.hold_first_submission_ms);
      return;
    }
    return reply(201);
  }
}

function main() {
  const cfg: DoublesConfig = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const doubles = {} as Record<Recipient, Recipient1>;
  let ready = 0;
  for (const r of ['P', 'Q'] as Recipient[]) {
    const d = (doubles[r] = new Recipient1(r, cfg.recipients[r], cfg.journal_dir));
    const server = createHttpServer({ keepAliveTimeout: 60_000, requestTimeout: 0, headersTimeout: 60_000 }, (req, res) => d.onRequest(req, res));
    server.on('connection', (s: Socket) => d.onConnection(s));
    server.listen(cfg.recipients[r].port, cfg.recipients[r].address, () => { if (++ready === 4) console.log('ready'); });
    const sock = join(cfg.ctl_dir, `${r}.sock`);
    const ctl = createNetServer(c => {
      let buf = '';
      c.on('data', chunk => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let out: unknown;
          try {
            const q = JSON.parse(line);
            if (q.op === 'fence' && typeof q.id === 'string') { const seq = d.append({ kind: 'fence', fence_id: q.id }); out = { ok: true, seq, state: d.snapshot() }; }
            else if (q.op === 'state') out = { ok: true, journal_seq: d.journalSeq, state: d.snapshot() };
            else if (q.op === 'tracker') out = { ok: true, tracker: { ...d.tracker } };
            else out = { ok: false, error: 'unknown op' };
          } catch (error) { out = { ok: false, error: String(error) }; }
          c.write(JSON.stringify(out) + '\n');
        }
      });
      c.on('error', () => { /* the reader went away */ });
    });
    ctl.listen(sock, () => { chmodSync(sock, 0o660); if (++ready === 4) console.log('ready'); });
  }
  const stop = () => { for (const r of ['P', 'Q'] as Recipient[]) doubles[r].close(); process.exit(0); };
  process.on('SIGTERM', stop);
}

if (require.main === module) main();
