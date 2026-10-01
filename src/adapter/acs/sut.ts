/**
 * Loader for the pinned ACS build produced by src/sut/checkout.ts#buildSut.
 * The adapter only uses components that exist at the pinned SHA; it never
 * adds exports to ACS. Types here are adapter-local structural views.
 */
import { join } from "node:path";
import { createRequire } from "node:module";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SutModules {
  GuardedExecutor: any;
  SchemaValidator: any;
  SignatureService: any;
  ReplayGuard: any;
  ReplayGuardError: any;
  Guardian: any;
  AuditCollector: any;
  ExecutionCorrelationStore: any;
  CorrelationError: any;
  ApprovalGrantVerifier: any;
  ApprovalVerificationError: any;
  CapabilityGrantVerifier: any;
  ExecutionGate: any;
  SignatureInvalidError: any;
  SchemaValidationError: any;
  AddressableSchemaError: any;
  tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  executionCounters: Record<string, number>;
  canonicalize: (v: unknown) => string;
}

export function loadSut(buildDir: string): SutModules {
  const m = (name: string) => require(join(buildDir, "src", name));
  const ge = m("guarded-executor");
  const sv = m("schema-validator");
  const ss = m("signature-service");
  const rg = m("replay-guard");
  const gd = m("guardian");
  const au = m("audit");
  const ec = m("execution-correlation");
  const av = m("approval-verifier");
  const cg = m("capability-grant");
  const eg = m("execution-gate");
  const tl = m("tools");
  // json-canonicalize is a runtime dependency of the pinned SUT, resolved exactly as the SUT resolves it.
  const jc = createRequire(join(buildDir, "src", "capability-grant.js"))("json-canonicalize");
  return {
    GuardedExecutor: ge.GuardedExecutor,
    SchemaValidator: sv.SchemaValidator,
    SchemaValidationError: sv.SchemaValidationError,
    AddressableSchemaError: sv.AddressableSchemaError,
    SignatureService: ss.SignatureService,
    SignatureInvalidError: ss.SignatureInvalidError,
    ReplayGuard: rg.ReplayGuard,
    ReplayGuardError: rg.ReplayGuardError,
    Guardian: gd.Guardian,
    AuditCollector: au.AuditCollector,
    ExecutionCorrelationStore: ec.ExecutionCorrelationStore,
    CorrelationError: ec.CorrelationError,
    ApprovalGrantVerifier: av.ApprovalGrantVerifier,
    ApprovalVerificationError: av.ApprovalVerificationError,
    CapabilityGrantVerifier: cg.CapabilityGrantVerifier,
    ExecutionGate: eg.ExecutionGate,
    tools: tl.tools,
    executionCounters: tl.executionCounters,
    canonicalize: jc.canonicalize,
  };
}
