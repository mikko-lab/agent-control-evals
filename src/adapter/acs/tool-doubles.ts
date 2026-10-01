/**
 * Harness-owned tool test doubles.
 *
 * The adapter temporarily registers these in the pinned SUT process's `tools`
 * registry so that result-gating scenarios get deterministic, corpus-defined
 * outputs and so that every execution can be attributed to a scenario
 * request. A double makes no decisions and contains no oracle logic: it
 * returns a deep copy of the corpus value and records that it ran.
 *
 * Isolation contract (tested in test/tool-doubles.test.ts):
 *  - install() snapshots the registry (own keys + function identities);
 *  - restore() puts back exactly that snapshot and verifies it;
 *  - the adapter processes cases strictly sequentially, and every case gets a
 *    fresh ToolDoubles instance, so no output or execution record survives a case.
 */
export const TRACE_ARG = "ace_trace";

export interface ExecutionRecord {
  tool: string;
  trace: string | null;
}

type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;

export class ToolStateLeakError extends Error {}

/** One owner per registry at a time: interleaved installs could restore a foreign snapshot and leak doubles. */
const owners = new WeakMap<object, ToolDoubles>();

export class ToolDoubles {
  readonly log: ExecutionRecord[] = [];
  private snapshot: Map<string, ToolFn> | null = null;

  constructor(
    private readonly registry: Record<string, ToolFn>,
    /** full trace ("<key>#<step>.<attempt>") -> corpus-defined output of that request step */
    private readonly outputs: Map<string, unknown>,
    private readonly toolNames: readonly string[],
  ) {}

  install(): void {
    if (this.snapshot) throw new ToolStateLeakError("doubles already installed");
    if (owners.has(this.registry)) throw new ToolStateLeakError("another case's tool doubles are still installed in this registry");
    owners.set(this.registry, this);
    this.snapshot = new Map(Object.entries(this.registry));
    for (const name of this.toolNames) {
      this.registry[name] = async (args: Record<string, unknown>) => {
        const trace = typeof args[TRACE_ARG] === "string" ? (args[TRACE_ARG] as string) : null;
        this.log.push({ tool: name, trace });
        const out = trace !== null && this.outputs.has(trace) ? this.outputs.get(trace) : { status: "ok" };
        return JSON.parse(JSON.stringify(out));
      };
    }
  }

  restore(): void {
    if (!this.snapshot) throw new ToolStateLeakError("doubles not installed");
    for (const k of Object.keys(this.registry)) if (!this.snapshot.has(k)) delete this.registry[k];
    for (const [k, fn] of this.snapshot) this.registry[k] = fn;
    const snap = this.snapshot;
    this.snapshot = null;
    owners.delete(this.registry);
    const keys = Object.keys(this.registry);
    if (keys.length !== snap.size || keys.some((k) => this.registry[k] !== snap.get(k))) {
      throw new ToolStateLeakError("tool registry not restored to its pre-case state");
    }
  }
}

/** Trace format: "<session>/<request>#<step>.<attempt>"; the key part identifies the scenario request. */
export function makeTrace(key: string, step: number, attempt: number): string {
  return `${key}#${step}.${attempt}`;
}
export function traceKey(trace: string): string {
  const i = trace.indexOf("#");
  return i < 0 ? trace : trace.slice(0, i);
}
