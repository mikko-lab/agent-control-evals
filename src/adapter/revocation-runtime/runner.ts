/**
 * In-process runtime adapter of the revocation track (docs/revocation/runtime-adapter-compatibility.md, sections 3-4
 * and 14; approval-permit lifecycle plan sections 7.1-7.2 and 9).
 *
 * It drives one fresh GuardedExecutor of the pinned SUT per case, in tenancy mode with the opt-in approval-permit
 * lifecycle (permit mode), strictly step by step, and records only what the SUT returned or exposed: the result of
 * each call (decision source) and full-state probes (effect source). Effects and decisions are derived from those
 * records by src/spec/revocation/runtime-observation.ts. The adapter never reads the oracle, never fills a missing
 * observation and never reports a decision for a harness control step (finish, seal). Every asynchronous barrier is an
 * explicit event with a bounded watchdog; `whenTerminal()` is only a wake-up.
 *
 * Lifecycle: the setup creates one lineage per authority through runtime calls only (process() of the authority's
 * fixed ASK request; for an `initial: issued` authority also approve() with a signed human ApprovalGrantV3 and
 * issuePermit()) and ends with the setup_baseline probe. Steps map approve -> approve(), issue -> issuePermit() and
 * start -> start() with a fresh signed request R′ carrying the lineage's tool and arguments. The adapter never grants,
 * issues, consumes or revokes on the runtime's behalf and keeps no lifecycle state of its own.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { RUNTIME_OBSERVATION_FORMAT_3 } from "../../spec/revocation/model";
import type { Authority, CallRecord, Diagnostic, Effect, Expected, IdentityMapping, LineageObservation, Probe, ProbePoint, ProbeState, RuntimeDecision, RuntimeEffect, RuntimeObservation, RuntimeTarget, Step } from "../../spec/revocation/model";
import { contractAncestors, decisionFromCall, derive, DECISION_PROVENANCE, EFFECT_PROVENANCE } from "../../spec/revocation/runtime-observation";
import { canonicalJson } from "../../util/canonical-json";
import type { RevocationSut } from "./sut";

export type DoubleVariant = "default" | "returns_unobservable_pending_promise";

/** A case as the adapter receives it: never its oracle expectations, family or purpose. */
export interface AdapterCase {
  id: string;
  authorities: Authority[];
  steps: Step[];
  double?: DoubleVariant;
}

/**
 * Deliberate adapter defects (section 10, AM1-AM10; plan section 7.7, AM11-AM13; approval-permit lifecycle plan
 * section 8.3, AM14-AM19), used only by tests and the mutation gate to show that each is detected. AM3 and AM6 corrupt
 * the report as AM1/AM2/AM5/AM9 do; AM4, AM7, AM8 and AM10 change how the adapter drives or probes the SUT. AM11
 * emulates a tenant revocation by session revocations, AM12 maps the pairs of one session name in two tenants onto one
 * runtime session, and AM13 issues every authority an independent grant (no parent link, no chain). AM14 refuses a
 * start itself, AM15 approves and issues a pending authority at setup, AM16 reports lifecycle effects from the call's
 * receipt, AM17 maps one authority to two lineages, AM18 approves and issues on the runtime's behalf after a denied
 * start, AM19 reports the setup state as step-0 effects.
 */
export const ADAPTER_FAULTS = [
  "AM1_backfill_from_oracle",
  "AM2_report_control_decisions",
  "AM3_attribute_by_intent",
  "AM4_microtask_deliver_barrier",
  "AM5_terminal_from_lock_release",
  "AM6_drop_commit_on_throw",
  "AM7_resubmit_request",
  "AM8_session_per_authority",
  "AM9_seq_by_array_order",
  "AM10_no_entry_probe",
  "AM11_tenant_revoke_as_session_revokes",
  "AM12_tenant_blind_session_mapping",
  "AM13_drop_parent_links",
  "AM14_refuse_start_without_permit",
  "AM15_setup_issues_pending",
  "AM16_lifecycle_effects_from_receipts",
  "AM17_two_lineages_per_authority",
  "AM18_issue_on_runtime_behalf",
  "AM19_setup_state_as_step_effects",
] as const;
export type AdapterFault = (typeof ADAPTER_FAULTS)[number];

export interface RunOptions {
  watchdogMs: number;
  controlSteps: readonly number[];
  fault?: AdapterFault;
  /** Only for AM1, the back-filling defect. A correct adapter never receives the oracle. */
  oracle?: Expected;
}

export interface RunResult {
  observation: RuntimeObservation;
  /** Every signed request the adapter submitted (request discipline, section 9.7): the setup requests (step -1) and every start's R′. */
  requests: { step: number; authority: string; request_id: string }[];
  clearSessionCalls: number;
  /** Times the unobservable Promise's constructor getter ran (must stay 0). */
  constructorGetterCalls: number;
}

const AGENT = "ace-revocation-agent";
const APPROVER_KEY_ID = "ace-approver-1";
const CAPABILITY_KEY_ID = "ace-cap-1";
const REQUEST_KEY_ID = "ace-req-1";
const REQUEST_ROOT_SECRET = "ace-revocation-request-root-secret";
const APPROVAL_FUTURE_SKEW_MS = 30_000;
const REQUEST_SKEW_WINDOW_MS = 300_000;
const TRACE_ARG = "ace_trace";
/** The ASK tool of every lineage: the Guardian answers ASK, so process() creates a pending lineage (plan section 7.2). */
const LINEAGE_TOOL = "update_record";
const APPROVER = { type: "human", id: "demo-operator" } as const;
const KEY_PREFIX = "ace:";

/** Deterministic RFC 4122-shaped UUID for a case-scoped label (same construction as the ACS adapter). */
export function uuidFor(caseId: string, ns: string, label: string): string {
  const h = createHash("sha256").update(`${caseId}|${ns}|${label}`).digest("hex");
  const variant = "89ab"[parseInt(h[16], 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Runtime session id of a contract (tenant, session) pair: exactly one per pair (section 3.1). */
export const sessionIdFor = (caseId: string, tenant: string, session: string) => uuidFor(caseId, "session", `${tenant}/${session}`);
export const capabilityIdFor = (caseId: string, authority: string) => uuidFor(caseId, "capability", authority);
/** Runtime tenant of a contract tenant: one per tenant, carried only in the issuer-signed grants (plan section 7.5). */
export const tenantIdFor = (caseId: string, tenant: string) => `ace-tenant-${uuidFor(caseId, "tenant", tenant)}`;

/**
 * The identity mapping the adapter uses for a case (section 3.1, plan sections 7.5-7.6), fixed before the run from
 * the case alone: one capability per authority, one runtime session per (tenant, session) pair, one runtime tenant
 * per tenant, and for every capability the chain of ancestor capabilities it is issued with (parent first).
 */
export function identityFor(c: Pick<AdapterCase, "id" | "authorities">, fault?: AdapterFault): IdentityMapping {
  const identity: IdentityMapping = { capabilities: {}, sessions: {}, tenants: {}, chains: {}, lineages: {} };
  for (const a of c.authorities) {
    identity.capabilities[capabilityIdFor(c.id, a.id)] = a.id;
    identity.sessions[runtimeSessionFor(c.id, a, fault)] = { tenant: a.tenant, session: a.session };
    identity.tenants![tenantIdFor(c.id, a.tenant)] = a.tenant;
    identity.chains![capabilityIdFor(c.id, a.id)] = fault === "AM13_drop_parent_links" ? [] : contractAncestors(c.authorities, a.id).map((x) => capabilityIdFor(c.id, x));
  }
  return identity;
}
function runtimeSessionFor(caseId: string, a: Authority, fault?: AdapterFault): string {
  if (fault === "AM8_session_per_authority") return uuidFor(caseId, "session-per-authority", a.id);
  if (fault === "AM12_tenant_blind_session_mapping") return uuidFor(caseId, "session", `*/${a.session}`);
  return sessionIdFor(caseId, a.tenant, a.session);
}
export const outputNonce = (label: string) => `ace-out:${label}`;
/** The fixed request marker of an authority's lineage: R′ must carry exactly the lineage's arguments (D5). */
export const traceFor = (authority: string) => `ace-authority:${authority}`;

export class HarnessFinish extends Error {
  constructor(label: string) {
    super(`harness finish of ${label}`);
    this.name = "HarnessFinish";
  }
}

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; settled: boolean }
function deferred<T>(): Deferred<T> {
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((res, rej) => {
    d.resolve = (v) => { d.settled = true; res(v); };
    d.reject = (e) => { d.settled = true; rej(e); };
  });
  return d;
}
const settle = () => new Promise<void>((r) => setImmediate(r));
/** Withheld-output codes of the pinned runtime that name a revocation (any scope); anything else is UNKNOWN. */
const REVOCATION_CODES = new Set(["capability_revoked", "session_revoked", "tenant_revoked", "ancestor_revoked"]);

interface PublicCall { state: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown }

export async function runCase(c: AdapterCase, sut: RevocationSut, o: RunOptions): Promise<RunResult> {
  const variant: DoubleVariant = c.double ?? "default";
  const control = new Set(o.controlSteps);
  const authorityById = new Map(c.authorities.map((a) => [a.id, a]));
  const pairSession = (a: Authority) => runtimeSessionFor(c.id, a, o.fault);
  const identity = identityFor(c, o.fault);

  // ---- SUT instance, fresh per case -------------------------------------------------------------------------------
  const keys = { approver: generateKeyPairSync("ed25519"), capability: generateKeyPairSync("ed25519") };
  // The SUT stamps its own result requests with the real time, so the case clock is the real time at case start,
  // held fixed for the case. No timestamp ever enters an observation.
  const BASE_MS = Date.now();
  const clock = { nowMs: () => BASE_MS };
  const iso = (ms: number) => new Date(ms).toISOString();
  const signEd25519 = (privateKey: KeyObject, unsigned: Record<string, unknown>) => sign(null, Buffer.from(sut.canonicalize(unsigned)), privateKey).toString("base64");
  const audit = new sut.AuditCollector();
  const signer = new sut.SignatureService(REQUEST_ROOT_SECRET, REQUEST_KEY_ID);
  const grantByRequest = new Map<string, unknown>();
  // The harness is the trusted issuer (plan section 7.6): every authority gets one issuer-signed tenant-bound grant
  // (tenancy mode). A derived authority's grant names its parent by capability_id and by the content fingerprint of
  // the parent's body, so parents are issued first. Attenuation holds by construction: a parent allows every tool of
  // its descendants, and a deeper grant's validity window lies inside its parent's. The provider answers a request of
  // an authority with a parent with the complete chain, leaf first, then ancestors from the parent up to the root.
  const grants = new Map<string, Record<string, unknown>>();
  const parentOf = (a: Authority) => (o.fault === "AM13_drop_parent_links" ? null : a.parent);
  // Every lineage runs the ASK tool, so every grant (and every parent's, by attenuation) allows exactly it.
  const toolsOf = (_a: Authority) => [LINEAGE_TOOL];
  const depthOf = (a: Authority) => contractAncestors(c.authorities, a.id).length;
  const issue = (a: Authority): Record<string, unknown> => {
    const have = grants.get(a.id);
    if (have) return have;
    const parentId = parentOf(a);
    const parent = parentId === null ? undefined : issue(authorityById.get(parentId)!);
    const depth = o.fault === "AM13_drop_parent_links" ? 0 : depthOf(a);
    const body: Record<string, unknown> = {
      version: 2,
      capability_id: capabilityIdFor(c.id, a.id),
      agent_id: AGENT,
      session_id: pairSession(a),
      tenant_id: tenantIdFor(c.id, a.tenant),
      ...(parent ? { parent: { capability_id: parent.capability_id, fingerprint: fingerprintOf(parent) } } : {}),
      allowed_tools: toolsOf(a),
      issued_at: iso(BASE_MS - 60_000 + 1_000 * depth),
      expires_at: iso(BASE_MS + 3_600_000 - 1_000 * depth),
    };
    const grant = { ...body, signature: { algorithm: "Ed25519", key_id: CAPABILITY_KEY_ID, value: signEd25519(keys.capability.privateKey, body) } };
    grants.set(a.id, grant);
    return grant;
  };
  /** SHA-256 of the canonical JSON of a grant's body (every field except the signature): the parent link's fingerprint. */
  const fingerprintOf = (grant: Record<string, unknown>) => {
    const { signature: _signature, ...body } = grant;
    return createHash("sha256").update(sut.canonicalize(body)).digest("hex");
  };
  for (const a of c.authorities) issue(a);
  const answerFor = (a: Authority): unknown => {
    const chain: unknown[] = [];
    for (let p = parentOf(a); p !== null; p = parentOf(authorityById.get(p)!)) chain.push(grants.get(p));
    return chain.length ? { kind: "capability_chain", leaf: grants.get(a.id), ancestors: chain } : grants.get(a.id);
  };
  const provider = {
    resolve(lc: { request_id: string }) {
      const g = grantByRequest.get(lc.request_id);
      if (!g) throw new Error("capability provider: unknown request");
      return g;
    },
  };
  const executor = new sut.GuardedExecutor(
    new sut.SchemaValidator(),
    signer,
    new sut.ReplayGuard({ skewWindowMs: REQUEST_SKEW_WINDOW_MS, clock, audit }),
    new sut.Guardian(),
    audit,
    new sut.ExecutionCorrelationStore(),
    new sut.ApprovalGrantVerifier(keys.approver.publicKey, APPROVER_KEY_ID),
    clock,
    APPROVAL_FUTURE_SKEW_MS,
    provider,
    new sut.CapabilityGrantVerifier(keys.capability.publicKey, CAPABILITY_KEY_ID, clock, { tenancy: true }),
    { lifecycle: "permit" },
  );
  let clearSessionCalls = 0;
  const clearSession = executor.clearSession.bind(executor);
  executor.clearSession = (...args: unknown[]) => { clearSessionCalls++; return clearSession(...args); };

  // ---- Records ------------------------------------------------------------------------------------------------------
  const probes: Probe[] = [];
  const calls: CallRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const requests: RunResult["requests"] = [];
  const receipts: ProbeState["receipts"] = [];
  const entries: ProbeState["entries"] = [];
  const contexts = new Map<string, { execution_id: string; commit: (k: string, v: unknown) => unknown; acknowledgeCancellation: () => boolean; track: (p: Promise<unknown>) => unknown }>();
  const locks = new Map<string, { L: Deferred<unknown>; M: Deferred<unknown> }>();
  const hidden = new Map<string, Deferred<unknown>>();
  const publics = new Map<string, PublicCall>();
  const traces = new Map<string, { authority: string; label: string }>();
  /** request_id of every start request R′ the adapter submitted -> its authority and execution label. */
  const startRequests = new Map<string, { authority: string; label: string }>();
  const lineageOf = new Map<string, string>();
  const firstRequest = new Map<string, unknown>();
  const commitCount = new Map<string, number>();
  let current = 0;
  let waiting = false;
  let closed = false;
  let complete = true;
  let getterCalls = 0;
  const diag = (step: number | null, code: string, detail: string) => diagnostics.push({ step, code, detail });

  const snapshot = (): ProbeState => {
    const executions: ProbeState["executions"] = [];
    for (const e of entries) {
      const s = executor.getExecution(e.execution_id);
      if (s) executions.push({ label: e.label, execution_id: e.execution_id, capability_id: s.capability_id, session_id: s.session_id, state: s.state, cancellation_acknowledged: s.cancellation_acknowledged, terminal: s.terminal ? { execution_id: String(s.terminal.execution_id), outcome: String(s.terminal.outcome) } : null, tenant_id: typeof s.tenant_id === "string" ? s.tenant_id : null, ancestor_capability_ids: Array.isArray(s.ancestor_capability_ids) ? s.ancestor_capability_ids.map(String) : [], request_id: String(s.request_id) });
    }
    const terminals = (executor.terminals() as { execution_id: unknown; outcome: unknown }[]).map((t) => ({ execution_id: String(t.execution_id), outcome: String(t.outcome) }));
    const view = executor.managedState;
    const managed = (view.keys() as string[]).map((key) => {
      const m = /^ace:(.+)#(\d+)$/.exec(key);
      const value = view.get(key);
      let value_json: string | null = null;
      if (value !== undefined) { try { value_json = canonicalJson(value); } catch { value_json = JSON.stringify(value) ?? "unserializable"; } }
      return m ? { key, label: m[1], n: Number(m[2]), value_json } : { key, label: "?", n: 1, value_json };
    });
    const deliveries = [...publics].filter(([label, p]) => delivered(label, p)).map(([label]) => ({ label }));
    const lineages = (executor.lineages() as LineageSnapshotView[]).map(lineageObservation);
    return { receipts: receipts.map((r) => ({ step: r.step, target: { ...r.target } })), entries: entries.map((e) => ({ ...e })), executions, terminals, managed, managed_version: Number(view.version), deliveries, lineages, authority_seq: Number(executor.authoritySequence()) };
  };
  const probe = (point: ProbePoint) => { if (!closed) probes.push({ index: probes.length, step: current, point, state: snapshot() }); };

  // Event wake-ups for barrier waits: no polling, no microtask counting.
  let event = deferred<void>();
  const fire = (takeProbe: boolean) => {
    if (closed) return;
    if (takeProbe && waiting) probe("event");
    const e = event;
    event = deferred<void>();
    e.resolve();
  };
  /** Waits until `cond` holds, woken only by SUT events; false when the watchdog expires first. */
  const waitUntil = async (cond: () => boolean): Promise<boolean> => {
    const deadline = Date.now() + o.watchdogMs;
    waiting = true;
    try {
      while (!cond()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((r) => { timer = setTimeout(r, remaining); });
        await Promise.race([event.promise, timeout]);
        clearTimeout(timer);
      }
      return true;
    } finally {
      waiting = false;
    }
  };
  const trackPublic = (label: string, p: Promise<unknown>) => {
    const rec: PublicCall = { state: "pending" };
    publics.set(label, rec);
    p.then(
      (v) => { rec.state = "fulfilled"; rec.value = v; fire(true); },
      (e) => { rec.state = "rejected"; rec.error = e; fire(true); },
    );
  };
  function delivered(label: string, p: PublicCall): boolean {
    if (p.state !== "fulfilled") return false;
    const v = p.value as { status?: unknown; result?: { exit_status?: unknown; outputs?: unknown } } | undefined;
    return v?.status === "executed" && v.result?.exit_status === "success" && JSON.stringify(v.result.outputs ?? null).includes(JSON.stringify(outputNonce(label)));
  }
  const errorClass = (e: unknown): string => {
    if (e instanceof sut.AuthorityRevokedError) return "AuthorityRevokedError";
    if (e instanceof sut.LifecycleDeniedError) return "LifecycleDeniedError";
    if (e instanceof sut.LifecycleModeError) return "LifecycleModeError";
    if (e instanceof sut.CommitRejectedError) return "CommitRejectedError";
    if (e instanceof sut.RevocationTargetError) return "RevocationTargetError";
    return `other:${e instanceof Error ? e.name : typeof e}`;
  };
  /** The lifecycle denial reason (with its field) of a LifecycleDeniedError; undefined for any other error. */
  const reasonOf = (e: unknown): string | undefined => (e instanceof sut.LifecycleDeniedError ? String((e as { qualifiedReason: unknown }).qualifiedReason) : undefined);
  const threw = (step: number, api: CallRecord["api"], e: unknown): CallRecord => {
    const reason = reasonOf(e);
    return { step, api, outcome: "threw", class: errorClass(e), ...(reason ? { reason } : {}) };
  };

  // ---- Tool double --------------------------------------------------------------------------------------------------
  const double = (args: Record<string, unknown>, ctx?: { execution_id: string; commit: (k: string, v: unknown) => unknown; acknowledgeCancellation: () => boolean; track: (p: Promise<unknown>) => unknown }): Promise<unknown> => {
    // The authority comes from the request marker of the lineage's arguments; the execution label from the runtime's
    // own record of the execution: the start request R′ it runs (never from the adapter's step counter).
    const marker = traces.get(String((args?.[TRACE_ARG] as { value?: unknown } | undefined)?.value ?? args?.[TRACE_ARG]));
    const record = ctx && !closed ? (executor.getExecution(ctx.execution_id) as { request_id?: unknown } | undefined) : undefined;
    const started = record ? startRequests.get(String(record.request_id)) : undefined;
    const t = marker && started && started.authority === marker.authority ? { authority: marker.authority, label: started.label } : undefined;
    if (!t || !ctx || closed) {
      diag(current, "unexpected_tool_invocation", `tool double invoked without a known request marker, start request or context`);
      return Promise.resolve({ ignored: true });
    }
    entries.push({ label: t.label, execution_id: ctx.execution_id, request_authority: t.authority });
    contexts.set(t.label, ctx);
    if (o.fault !== "AM10_no_entry_probe") probe("tool_entry");
    if (variant === "returns_unobservable_pending_promise") {
      const p = deferred<unknown>();
      Object.defineProperty(p.promise, "constructor", { get() { getterCalls++; throw new Error("constructor getter must not run"); } });
      hidden.set(t.label, p);
      fire(false);
      return p.promise;
    }
    const L = deferred<unknown>();
    const M = deferred<unknown>();
    ctx.track(L.promise);
    locks.set(t.label, { L, M });
    fire(false);
    return M.promise;
  };
  const toolNames = ["read_record", "update_record"];
  const saved = new Map(toolNames.map((n) => [n, sut.tools[n]]));
  for (const n of toolNames) sut.tools[n] = double;

  /**
   * A signed request of `authority`'s lineage: its fixed tool and arguments (the request marker), a fresh request_id
   * per submission. `label` is the execution a start request starts (null for the setup's creation request).
   */
  const makeRequest = (authority: string, label: string | null, step: number | string) => {
    if (o.fault === "AM7_resubmit_request" && firstRequest.has(authority)) {
      const reused = firstRequest.get(authority) as { params: { request_id: string } };
      requests.push({ step: typeof step === "number" ? step : -1, authority, request_id: reused.params.request_id });
      return reused;
    }
    const a = authorityById.get(authority)!;
    const requestId = uuidFor(c.id, "request", `${authority}/${step}`);
    const trace = traceFor(authority);
    traces.set(trace, { authority, label: "lineage" });
    if (label !== null) startRequests.set(requestId, { authority, label });
    grantByRequest.set(requestId, answerFor(a));
    const envelope = {
      jsonrpc: "2.0",
      method: "steps/toolCallRequest",
      id: uuidFor(c.id, "rpc", `${trace}/${step}`),
      params: {
        acs_version: "0.1.0",
        request_id: requestId,
        timestamp: iso(BASE_MS),
        metadata: { agent_id: AGENT, session_id: pairSession(a) },
        payload: { tool: { name: LINEAGE_TOOL }, arguments: { [TRACE_ARG]: { value: trace } } },
      },
    };
    const signed = signer.signRequest(envelope);
    if (!firstRequest.has(authority)) firstRequest.set(authority, signed);
    requests.push({ step: typeof step === "number" ? step : -1, authority, request_id: requestId });
    return signed;
  };
  /** A signed human ApprovalGrantV3 for a lineage, from the runtime's own snapshot of its bindings. */
  const approvalFor = (lineageId: string) => {
    const snap = executor.getLineage(lineageId) as LineageSnapshotView | undefined;
    if (!snap) return undefined;
    const body: Record<string, unknown> = {
      version: 3,
      decision: "approve",
      lineage_id: snap.lineage_id,
      session_id: snap.bindings.session_id,
      request_id: snap.bindings.request_id,
      tool: snap.bindings.tool,
      request_digest: snap.bindings.request_digest,
      authority_fingerprint: snap.bindings.authority_fingerprint,
      approver: { ...APPROVER },
      issued_at: iso(BASE_MS),
    };
    return { ...body, signature: { algorithm: "Ed25519", key_id: APPROVER_KEY_ID, value: signEd25519(keys.approver.privateKey, body) } };
  };
  /** Setup only (and the AM18 defect): approve and issue a lineage through the runtime. */
  const approveAndIssue = (lineageId: string) => {
    executor.approve(approvalFor(lineageId));
    executor.issuePermit({ lineage_id: lineageId });
  };
  /**
   * Runtime targets of a contract revocation: one target, mapped, never enumerated. Only the AM11 defect expands a
   * tenant revocation into one session revocation per known session of the tenant.
   */
  const runtimeTargets = (t: Extract<Step, { op: "revoke" }>["target"]): RuntimeTarget[] => {
    if (t.scope === "authority") return [{ scope: "capability", capability_id: capabilityIdFor(c.id, t.id) }];
    if (t.scope === "session") {
      const a = c.authorities.find((x) => x.tenant === t.tenant && x.session === t.session);
      return [{ scope: "session", session_id: a ? pairSession(a) : sessionIdFor(c.id, t.tenant, t.session) }];
    }
    if (o.fault === "AM11_tenant_revoke_as_session_revokes") return [...new Set(c.authorities.filter((x) => x.tenant === t.tenant).map(pairSession))].map((session_id) => ({ scope: "session", session_id }));
    return [{ scope: "tenant", tenant_id: tenantIdFor(c.id, t.tenant) }];
  };
  const executionState = (label: string) => {
    const e = entries.find((x) => x.label === label);
    return e ? (executor.getExecution(e.execution_id)?.state as string | undefined) : undefined;
  };
  const startLike = async (step: number, label: string, api: "start", p: Promise<unknown>, requestId: string) => {
    trackPublic(label, p);
    const holdsTool = variant === "default";
    const entered = () => entries.some((x) => x.label === label);
    const ok = await waitUntil(() => (entered() ? holdsTool || publics.get(label)!.state !== "pending" : publics.get(label)!.state !== "pending"));
    const pub = publics.get(label)!;
    const reason = pub.state === "rejected" ? reasonOf(pub.error) : undefined;
    if (entered()) calls.push({ step, api, outcome: "tool_invoked", request_id: requestId });
    else if (!ok) { complete = false; calls.push({ step, api, outcome: "timeout", request_id: requestId }); diag(step, "barrier_timeout", `${api} of ${label}: neither the tool double nor the public promise answered`); }
    else if (pub.state === "rejected") calls.push({ step, api, outcome: "rejected", class: errorClass(pub.error), ...(reason ? { reason } : {}), request_id: requestId });
    else calls.push({ step, api, outcome: "fulfilled", value: JSON.stringify((pub.value as { status?: unknown })?.status ?? null), request_id: requestId });
    if (entered() && !ok) { complete = false; diag(step, "barrier_timeout", `${api} of ${label}: the public promise did not settle`); }
  };

  // ---- Drive the case -----------------------------------------------------------------------------------------------
  try {
    // ---- Setup (never assessed): one lineage per authority through runtime calls, then the baseline probe -----------
    for (const a of c.authorities) {
      const created: string[] = [];
      for (let n = 0; n < (o.fault === "AM17_two_lineages_per_authority" && a === c.authorities[0] ? 2 : 1); n++) {
        const p = executor.process(makeRequest(a.id, null, n === 0 ? "setup" : `setup-${n + 1}`));
        let timer: NodeJS.Timeout | undefined;
        const r = await Promise.race([p.then((v: unknown) => ({ v }), (e: unknown) => ({ e })), new Promise<{ timeout: true }>((res) => { timer = setTimeout(() => res({ timeout: true }), o.watchdogMs); })]);
        clearTimeout(timer);
        const v = "v" in r ? (r.v as { status?: unknown; lineage_id?: unknown }) : undefined;
        if (v?.status !== "pending" || typeof v.lineage_id !== "string") {
          diag(null, "setup_failed", `process() of ${a.id}'s lineage request did not return a pending lineage: ${v ? JSON.stringify(v) : "e" in r ? String(r.e) : "timeout"}`);
          complete = false;
          throw new SetupFailed();
        }
        created.push(v.lineage_id);
      }
      for (const lid of created) identity.lineages![lid] = a.id;
      lineageOf.set(a.id, created[0]);
      if (a.initial === "issued" || o.fault === "AM15_setup_issues_pending") {
        try { approveAndIssue(created[0]); } catch (e) {
          diag(null, "setup_failed", `setup approve and issue of ${a.id}'s lineage failed: ${e instanceof Error ? e.message : String(e)}`);
          complete = false;
          throw new SetupFailed();
        }
      }
    }
    probe("setup_baseline");
    for (let i = 0; i < c.steps.length; i++) {
      const s = c.steps[i];
      await settle();
      current = i;
      probe("pre_action");
      switch (s.op) {
        case "revoke": {
          for (const rt of runtimeTargets(s.target)) {
            try {
              const receipt = executor.revoke(rt);
              receipts.push({ step: i, target: { ...receipt.target } });
              calls.push({ step: i, api: "revoke", outcome: "returned" });
            } catch (e) {
              calls.push(threw(i, "revoke", e));
            }
          }
          break;
        }
        case "start": {
          const lineageId = lineageOf.get(s.authority)!;
          if (o.fault === "AM14_refuse_start_without_permit" && (executor.getLineage(lineageId) as LineageSnapshotView | undefined)?.permit.state !== "issued") break;
          const r = makeRequest(s.authority, s.execution, i) as { params: { request_id: string } };
          await startLike(i, s.execution, "start", executor.start({ lineage_id: lineageId, request: r }), r.params.request_id);
          if (o.fault === "AM18_issue_on_runtime_behalf" && calls.some((x) => x.step === i && x.reason === "permit_not_issued")) {
            try { approveAndIssue(lineageId); } catch { /* the defect only tries */ }
          }
          break;
        }
        case "approve": {
          try {
            executor.approve(approvalFor(lineageOf.get(s.authority)!));
            calls.push({ step: i, api: "approve", outcome: "returned" });
          } catch (e) {
            calls.push(threw(i, "approve", e));
          }
          break;
        }
        case "issue": {
          try {
            executor.issuePermit({ lineage_id: lineageOf.get(s.authority)! });
            calls.push({ step: i, api: "issuePermit", outcome: "returned" });
          } catch (e) {
            calls.push(threw(i, "issuePermit", e));
          }
          break;
        }
        case "commit": {
          const ctx = contexts.get(s.execution);
          if (!ctx) { diag(i, "no_execution_context", `commit of ${s.execution}, which the runtime never started`); break; }
          const n = (commitCount.get(s.execution) ?? 0) + 1;
          commitCount.set(s.execution, n);
          try {
            ctx.commit(`${KEY_PREFIX}${s.execution}#${n}`, { label: s.execution, n });
            calls.push({ step: i, api: "commit", outcome: "returned" });
          } catch (e) {
            calls.push(threw(i, "commit", e));
          }
          break;
        }
        case "deliver": {
          const lock = locks.get(s.execution);
          const pub = publics.get(s.execution);
          if (!lock || !pub) { diag(i, "no_execution_context", `deliver of ${s.execution}, which the runtime never started`); break; }
          if (!lock.M.settled) lock.M.resolve({ nonce: outputNonce(s.execution) });
          let ok = true;
          if (o.fault === "AM4_microtask_deliver_barrier") { for (let k = 0; k < 3; k++) await Promise.resolve(); }
          else ok = await waitUntil(() => pub.state !== "pending");
          if (pub.state === "pending") {
            complete = false;
            calls.push({ step: i, api: "deliver", outcome: "timeout" });
            if (!ok) diag(i, "barrier_timeout", `deliver of ${s.execution}: the public promise did not settle`);
          } else if (pub.state === "rejected") calls.push({ step: i, api: "deliver", outcome: "rejected", class: errorClass(pub.error) });
          else {
            const v = pub.value as { result?: { exit_status?: unknown; outputs?: { value?: { code?: unknown } }[] } };
            const code = v?.result?.outputs?.[0]?.value?.code;
            const value = delivered(s.execution, pub) ? "delivered" : v?.result?.exit_status === "blocked" && typeof code === "string" && REVOCATION_CODES.has(code) ? "withheld_revoked" : `other:${String(v?.result?.exit_status)}`;
            calls.push({ step: i, api: "deliver", outcome: "fulfilled", value });
          }
          break;
        }
        case "cancel_ack": {
          const ctx = contexts.get(s.execution);
          if (!ctx) { diag(i, "no_execution_context", `cancel_ack of ${s.execution}, which the runtime never started`); break; }
          try {
            calls.push({ step: i, api: "acknowledgeCancellation", outcome: "returned", value: ctx.acknowledgeCancellation() === true });
          } catch (e) {
            calls.push(threw(i, "acknowledgeCancellation", e));
          }
          break;
        }
        case "finish": {
          // Harness control: end the tool's work. The terminal is observed separately in the runtime's state.
          const entry = entries.find((x) => x.label === s.execution);
          if (!entry) break;
          const lock = locks.get(s.execution);
          if (lock) {
            if (!lock.L.settled) lock.L.resolve(undefined);
            if (!lock.M.settled) lock.M.reject(new HarnessFinish(s.execution));
          }
          const h = hidden.get(s.execution);
          if (h && !h.settled) h.resolve({ nonce: outputNonce(s.execution) });
          const pub = publics.get(s.execution);
          // Bounded wake-up only: the runtime's whenTerminal() never decides anything here.
          (executor.whenTerminal(entry.execution_id) as Promise<unknown>).then(() => fire(true), () => fire(true));
          const ok = await waitUntil(() => {
            const st = executionState(s.execution);
            return (st === "terminal" || st === "unobservable") && (!pub || pub.state !== "pending");
          });
          if (!ok) { complete = false; diag(i, "barrier_timeout", `finish of ${s.execution}: no terminal (state ${String(executionState(s.execution))}) or unsettled public promise`); }
          if (executionState(s.execution) === "unobservable") diag(i, "unobservable_settlement", `execution ${s.execution} is in the runtime state unobservable: no terminal will be recorded`);
          break;
        }
        case "seal":
          await settle();
          probe("seal_settle");
          continue;
      }
      probe("barrier_complete");
    }
  } catch (e) {
    if (!(e instanceof SetupFailed)) {
      complete = false;
      diag(current, "adapter_abort", `adapter aborted the case: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    closed = true;
    // Cleanup after the observation is frozen; nothing of it is observed.
    for (const { L, M } of locks.values()) { if (!L.settled) L.resolve(undefined); if (!M.settled) M.resolve({ cleanup: true }); }
    for (const h of hidden.values()) if (!h.settled) h.resolve({ cleanup: true });
    for (const [n, f] of saved) sut.tools[n] = f;
  }
  if (getterCalls > 0) diag(null, "constructor_getter_ran", `the unobservable Promise's constructor getter ran ${getterCalls} time(s)`);

  const derived = derive(probes, identity);
  if (derived.drift.length) complete = false;
  for (const d of derived.drift) diag(probes[d.probe].step, "drift", `${d.key} first observed at probe ${d.probe} (${d.point}), outside every step barrier`);
  const { decisions, effects } = report(c, probes, calls, identity, control, o, entries, traces);
  return {
    observation: { format: RUNTIME_OBSERVATION_FORMAT_3, case_id: c.id, complete, decisions, effects, identity, probes, calls, diagnostics },
    requests,
    clearSessionCalls,
    constructorGetterCalls: getterCalls,
  };
}

class SetupFailed extends Error {}

/** The runtime's LineageSnapshot, as far as the adapter reads it. */
interface LineageSnapshotView {
  lineage_id: string;
  state: LineageObservation["state"];
  bindings: { agent_id: string; session_id: string; tenant_id?: string; tool: string; arguments_digest: string; capability_id: string; ancestor_capability_ids: string[]; request_id: string; request_digest: string; authority_fingerprint: string };
  approval: { state: LineageObservation["approval_state"]; approver: { type: string }; created_seq: number; approved_seq?: number };
  permit: { state: LineageObservation["permit_state"]; permit_id?: string; issued_seq?: number; consumed_seq?: number; execution_id?: string; start_request_id?: string };
}
/** A lineage snapshot as observed: every state, sequence value, id and binding; no timestamp. */
function lineageObservation(l: LineageSnapshotView): LineageObservation {
  const b = l.bindings;
  return {
    lineage_id: l.lineage_id, state: l.state, approval_state: l.approval.state, approver_type: String(l.approval.approver.type), created_seq: l.approval.created_seq, approved_seq: l.approval.approved_seq ?? null,
    permit_state: l.permit.state, permit_id: l.permit.permit_id ?? null, issued_seq: l.permit.issued_seq ?? null, consumed_seq: l.permit.consumed_seq ?? null, execution_id: l.permit.execution_id ?? null, start_request_id: l.permit.start_request_id ?? null,
    capability_id: b.capability_id, ancestor_capability_ids: [...b.ancestor_capability_ids], session_id: b.session_id, tenant_id: b.tenant_id ?? null, agent_id: b.agent_id, tool: b.tool, arguments_digest: b.arguments_digest, request_id: b.request_id, request_digest: b.request_digest,
  };
}

/**
 * The adapter's report: exactly the effects and decisions derived from its probe log and call records. The adapter
 * faults that corrupt the report (AM1, AM2, AM3, AM5, AM6, AM9) are applied here, after derivation.
 */
export function report(
  c: AdapterCase,
  probes: Probe[],
  calls: CallRecord[],
  identity: IdentityMapping,
  control: Set<number>,
  o: Pick<RunOptions, "fault" | "oracle">,
  entries: ProbeState["entries"] = [],
  traces: Map<string, { authority: string; label: string }> = new Map(),
): { decisions: RuntimeDecision[]; effects: RuntimeEffect[] } {
  const derived = derive(probes, identity);
  let effects: RuntimeEffect[] = derived.effects.map((x) => ({ ...x.effect, provenance: [...EFFECT_PROVENANCE[x.effect.kind]] }));
  const decisions: RuntimeDecision[] = [];
  c.steps.forEach((s, step) => {
    if (control.has(step)) return;
    const d = decisionFromCall(s, calls.find((x) => x.step === step));
    if (d !== undefined) decisions.push({ step, decision: d, provenance: [...DECISION_PROVENANCE] });
  });
  if (o.fault === "AM1_backfill_from_oracle" && o.oracle) {
    for (const d of o.oracle.decisions) {
      if (control.has(d.step)) continue;
      const have = decisions.find((x) => x.step === d.step);
      if (!have) decisions.push({ step: d.step, decision: d.decision, provenance: [...DECISION_PROVENANCE] });
      else if (have.decision === "UNKNOWN") have.decision = d.decision;
    }
  }
  if (o.fault === "AM2_report_control_decisions") for (const step of control) decisions.push({ step, decision: "ALLOW", provenance: [...DECISION_PROVENANCE] });
  // AM14: a start the adapter refused itself has no call record; the defect reports its own DENY.
  if (o.fault === "AM14_refuse_start_without_permit") c.steps.forEach((s, step) => { if (s.op === "start" && !control.has(step) && !calls.some((x) => x.step === step)) decisions.push({ step, decision: "DENY", provenance: [...DECISION_PROVENANCE] }); });
  // AM16: lifecycle effects from the call's receipt (a returned approve or issuePermit), not from the lineage snapshot.
  if (o.fault === "AM16_lifecycle_effects_from_receipts") {
    effects = effects.filter((f) => f.kind !== "approval_granted" && f.kind !== "permit_issued");
    for (const x of calls) {
      const s = c.steps[x.step];
      if (x.outcome !== "returned" || (x.api !== "approve" && x.api !== "issuePermit") || !s || !("authority" in s)) continue;
      const kind = x.api === "approve" ? "approval_granted" : "permit_issued";
      effects.push({ step: x.step, kind, authority: s.authority, execution: null, target: null, seq: Math.max(probes.findIndex((p) => p.step === x.step && p.point === "barrier_complete"), 0), provenance: [...EFFECT_PROVENANCE[kind]] });
    }
  }
  // AM19: the setup state of an `initial: issued` authority reported as step-0 effects, from the first snapshot.
  if (o.fault === "AM19_setup_state_as_step_effects") {
    for (const a of c.authorities) if (a.initial === "issued") for (const kind of ["approval_granted", "permit_issued"] as const) effects.push({ step: 0, kind, authority: a.id, execution: null, target: null, seq: 0, provenance: [...EFFECT_PROVENANCE[kind]] });
  }
  if (o.fault === "AM3_attribute_by_intent") {
    const intended = new Map([...traces.values()].map((t) => [t.label, t.authority]));
    effects = effects.map((f) => (f.execution !== null && intended.has(f.execution) ? { ...f, authority: intended.get(f.execution)! } : f));
  }
  if (o.fault === "AM5_terminal_from_lock_release") {
    c.steps.forEach((s, step) => {
      if (s.op !== "finish" || !entries.some((x) => x.label === s.execution) || effects.some((f) => f.kind === "execution_terminal" && f.execution === s.execution)) return;
      const seq = probes.findIndex((p) => p.step === step && p.point === "barrier_complete");
      effects.push({ step, kind: "execution_terminal", authority: s.authority, execution: s.execution, target: null, seq: Math.max(seq, 0), provenance: [...EFFECT_PROVENANCE.execution_terminal] });
    });
  }
  if (o.fault === "AM6_drop_commit_on_throw") effects = effects.filter((f) => !(f.kind === "tool_commit" && calls.some((x) => x.step === f.step && x.outcome === "threw")));
  if (o.fault === "AM9_seq_by_array_order") {
    effects = [...effects].sort((a, b) => a.step - b.step || a.kind.localeCompare(b.kind)).map((f, k) => ({ ...f, seq: k }));
  }
  effects.sort((a, b) => a.seq - b.seq || effectOrder(a).localeCompare(effectOrder(b)));
  decisions.sort((a, b) => a.step - b.step);
  return { decisions, effects };
}
const effectOrder = (f: Effect) => `${f.kind}|${f.authority}|${f.execution}|${JSON.stringify(f.target)}`;

/** Request discipline (section 9.7): every start attempt is a distinct request; clearSession() is never called. */
export function requestDisciplineIssues(r: RunResult): string[] {
  const issues: string[] = [];
  const ids = r.requests.map((x) => x.request_id);
  if (new Set(ids).size !== ids.length) issues.push("a signed request was submitted more than once");
  if (r.clearSessionCalls !== 0) issues.push("clearSession() was called");
  return issues;
}

/**
 * Session discipline (section 9.8): authorities of one (tenant, session) pair share exactly one runtime session, and
 * every authority has its own capability.
 */
export function sessionDisciplineIssues(c: AdapterCase, o: RuntimeObservation): string[] {
  const issues: string[] = [];
  const pairs = new Map<string, Set<string>>();
  for (const [sid, pair] of Object.entries(o.identity.sessions)) {
    const key = `${pair.tenant}/${pair.session}`;
    pairs.set(key, (pairs.get(key) ?? new Set()).add(sid));
  }
  for (const [pair, sids] of pairs) if (sids.size !== 1) issues.push(`pair ${pair} maps to ${sids.size} runtime sessions`);
  const caps = Object.values(o.identity.capabilities);
  if (new Set(caps).size !== caps.length || caps.length !== c.authorities.length) issues.push("capabilities are not one per authority");
  for (const p of o.probes) for (const x of p.state.executions) {
    const a = c.authorities.find((y) => y.id === o.identity.capabilities[x.capability_id]);
    const pair = o.identity.sessions[x.session_id];
    if (a && (!pair || pair.tenant !== a.tenant || pair.session !== a.session)) issues.push(`execution ${x.label} runs in a session not of its authority's pair`);
  }
  return [...new Set(issues)];
}
