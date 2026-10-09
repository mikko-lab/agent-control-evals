/**
 * Loader for the revocation track's pinned SUT build (src/sut/revocation-env.ts). It loads only components that exist
 * at the pinned commit and never patches, re-exports or extends them. Types are adapter-local structural views.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RevocationSut {
  GuardedExecutor: any;
  AuthorityRevokedError: any;
  CommitRejectedError: any;
  RevocationTargetError: any;
  SchemaValidator: any;
  SignatureService: any;
  ReplayGuard: any;
  Guardian: any;
  AuditCollector: any;
  ExecutionCorrelationStore: any;
  ApprovalGrantVerifier: any;
  CapabilityGrantVerifier: any;
  tools: Record<string, (args: Record<string, unknown>, ctx?: any) => Promise<unknown>>;
  canonicalize: (v: unknown) => string;
}

export function loadRevocationSut(buildDir: string): RevocationSut {
  const m = (name: string) => require(join(buildDir, "src", name));
  const ge = m("guarded-executor");
  const me = m("managed-execution");
  const ar = m("authority-revocation");
  const jc = createRequire(join(buildDir, "src", "capability-grant.js"))("json-canonicalize");
  return {
    GuardedExecutor: ge.GuardedExecutor,
    AuthorityRevokedError: ge.AuthorityRevokedError,
    CommitRejectedError: me.CommitRejectedError,
    RevocationTargetError: ar.RevocationTargetError,
    SchemaValidator: m("schema-validator").SchemaValidator,
    SignatureService: m("signature-service").SignatureService,
    ReplayGuard: m("replay-guard").ReplayGuard,
    Guardian: m("guardian").Guardian,
    AuditCollector: m("audit").AuditCollector,
    ExecutionCorrelationStore: m("execution-correlation").ExecutionCorrelationStore,
    ApprovalGrantVerifier: m("approval-verifier").ApprovalGrantVerifier,
    CapabilityGrantVerifier: m("capability-grant").CapabilityGrantVerifier,
    tools: m("tools").tools,
    canonicalize: jc.canonicalize,
  };
}
