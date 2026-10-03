/**
 * Harness side of the automotive adapter protocol (auto-adapter-0.1.0): spawns
 * the adapter process (no shell) and exchanges JSON Lines over stdin/stdout,
 * one request in flight at a time.
 *
 * Every deviation (invalid JSON, timeout, premature exit, unsolicited output,
 * wrong message type, version or case id, malformed observations) rejects with
 * AutomotiveClientError or AutomotiveProtocolError and poisons the client: after
 * a failure no further request is sent. These are adapter/client/protocol
 * errors, never automotive verdicts; mapping them to harness semantics is PR D's
 * job. stderr is kept as a diagnostic tail only and is never parsed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION } from "../../spec/automotive/version";
import type { AutomotiveCaseForAdapter } from "../../corpus/automotive/types";
import { AutomotiveProtocolError, automotiveCaseMessage, validateAutomotiveCaseResult, validateAutomotiveHello, type AutomotiveCaseResult, type AutomotiveHelloResponse } from "./protocol";

/**
 * Deterministic client error kinds, so a caller can classify a failure without parsing messages:
 *  - timeout:      the adapter did not answer within the configured timeout;
 *  - process_exit: the adapter process exited (or was not running) while the client still needed it;
 *  - spawn:        the adapter process could not be started;
 *  - client_state: the client was used out of order (no handshake, request in flight, repeated handshake).
 */
export type AutomotiveClientErrorKind = "timeout" | "process_exit" | "spawn" | "client_state";

export class AutomotiveClientError extends Error {
  constructor(
    message: string,
    readonly kind: AutomotiveClientErrorKind,
  ) {
    super(message);
    this.name = "AutomotiveClientError";
  }
}

export interface AutomotiveAdapterCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const STDERR_TAIL = 8_000;

export class AutomotiveAdapterClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private waiter: { resolve: (v: unknown) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private exitCode: number | null = null;
  private exited = false;
  private shuttingDown = false;
  private handshake: AutomotiveHelloResponse | null = null;
  private stderrTail = "";

  constructor(cmd: AutomotiveAdapterCommand, private readonly timeoutMs = 10_000) {
    this.proc = spawn(cmd.command, cmd.args, { shell: false, env: { ...process.env, ...(cmd.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-STDERR_TAIL);
    });
    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const w = this.waiter;
      if (!w) {
        this.poison(new AutomotiveProtocolError("adapter wrote an unsolicited line"));
        return;
      }
      this.waiter = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const e = new AutomotiveProtocolError("adapter wrote invalid JSON");
        this.poison(e);
        w.reject(e);
        return;
      }
      w.resolve(parsed);
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      if (!this.shuttingDown) this.poison(new AutomotiveClientError(`adapter exited prematurely (code ${code}, signal ${signal}); stderr tail: ${this.stderrTail}`, "process_exit"));
    });
    this.proc.on("error", (e) => this.poison(new AutomotiveClientError(`failed to spawn adapter: ${e.message}`, "spawn")));
    // A closed stdin (adapter gone) must surface as the exit/poison error, not as an unhandled EPIPE.
    this.proc.stdin.on("error", () => undefined);
  }

  /** Diagnostic stderr tail. Never protocol input. */
  get stderr(): string {
    return this.stderrTail;
  }

  get hello(): AutomotiveHelloResponse | null {
    return this.handshake;
  }

  private poison(e: Error): void {
    if (!this.failure) this.failure = e;
    const w = this.waiter;
    this.waiter = null;
    if (w) w.reject(this.failure);
  }

  private request(msg: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exited) return Promise.reject(new AutomotiveClientError("adapter process is not running", "process_exit"));
    if (this.waiter) return Promise.reject(new AutomotiveClientError("a request is already in flight", "client_state"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.poison(new AutomotiveClientError(`adapter did not answer within ${this.timeoutMs} ms`, "timeout"));
        this.proc.kill("SIGKILL");
      }, this.timeoutMs);
      this.waiter = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  /** Validates a response; a protocol violation poisons the client. */
  private checked<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      this.poison(e as Error);
      throw e;
    }
  }

  async helloHandshake(): Promise<AutomotiveHelloResponse> {
    if (this.handshake) throw new AutomotiveClientError("handshake already completed", "client_state");
    const raw = await this.request({ type: "hello", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION });
    this.handshake = this.checked(() => validateAutomotiveHello(raw));
    return this.handshake;
  }

  /** Sends one adapter view and returns the validated result (status ok or adapter_error). */
  async runCase(view: AutomotiveCaseForAdapter): Promise<AutomotiveCaseResult> {
    if (!this.handshake) throw new AutomotiveClientError("hello handshake required before cases", "client_state");
    const msg = automotiveCaseMessage(view);
    const raw = await this.request(msg);
    return this.checked(() => validateAutomotiveCaseResult(raw, view));
  }

  /** Graceful shutdown; kills the process if it does not exit in time. Resolves with the exit code (null if killed or unknown). */
  async shutdown(graceMs = 2_000): Promise<number | null> {
    this.shuttingDown = true;
    if (this.exited) return this.exitCode;
    return new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve(null);
      }, graceMs);
      this.proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.proc.stdin.write(JSON.stringify({ type: "shutdown", protocol_version: AUTOMOTIVE_ADAPTER_PROTOCOL_VERSION }) + "\n");
      this.proc.stdin.end();
    });
  }
}
