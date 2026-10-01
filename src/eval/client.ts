/**
 * Harness side of adapter protocol v1: spawns the adapter process and
 * exchanges JSON Lines. Every deviation (bad JSON, wrong case_id, early exit,
 * timeout) is a HarnessError/ProtocolError that invalidates the run; it is
 * never turned into a safety outcome.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, ProtocolError, validateCaseResult, validateHello, type CaseResult, type HelloResponse } from "../adapter/protocol";
import type { CaseForAdapter } from "../corpus/types";

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export interface AdapterCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class AdapterClient {
  private proc: ChildProcessWithoutNullStreams;
  private waiters: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private exited: Error | null = null;
  private stderr = "";

  constructor(cmd: AdapterCommand, private readonly timeoutMs = 60_000) {
    this.proc = spawn(cmd.command, cmd.args, { env: { ...process.env, ...(cmd.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d.toString()).slice(-8_000);
    });
    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const w = this.waiters.shift();
      if (!w) {
        this.fail(new ProtocolError("adapter wrote an unsolicited line"));
        return;
      }
      try {
        w.resolve(JSON.parse(line));
      } catch {
        w.reject(new ProtocolError("adapter wrote invalid JSON"));
      }
    });
    this.proc.on("exit", (code, signal) => this.fail(new ProtocolError(`adapter exited (code ${code}, signal ${signal}); stderr tail: ${this.stderr}`)));
    this.proc.on("error", (e) => this.fail(new HarnessError(`failed to spawn adapter: ${e.message}`)));
  }

  private fail(e: Error) {
    if (!this.exited) this.exited = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  private request(msg: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new HarnessError(`adapter did not answer within ${this.timeoutMs} ms`);
        this.fail(e);
        this.proc.kill("SIGKILL");
      }, this.timeoutMs);
      this.waiters.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  async hello(): Promise<HelloResponse> {
    return validateHello(await this.request({ type: "hello", protocol_version: PROTOCOL_VERSION }));
  }

  async runCase(c: CaseForAdapter): Promise<CaseResult> {
    const raw = await this.request({ type: "case", protocol_version: PROTOCOL_VERSION, case: c });
    return validateCaseResult(raw, c.case_id, c.evaluation_boundary);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.stdin.write(JSON.stringify({ type: "shutdown", protocol_version: PROTOCOL_VERSION }) + "\n");
      this.proc.stdin.end();
      setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
  }
}
