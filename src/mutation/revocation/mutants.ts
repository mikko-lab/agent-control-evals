/**
 * SUT mutants of the revocation track's pinned runtime (docs/revocation/runtime-adapter-compatibility.md, sections 10
 * and 14; approval-permit lifecycle plan section 8.1).
 * Each is one type-safe patch of one file of the pinned acs-guardrail-demo tree under mutations/revocation/, applied to
 * a fresh checkout. Patches, witnesses, exact expected values and evidence kinds are fixed in the committed, golden-
 * hashed manifest mutations/revocation/manifest.json before any mutant run, together with every harness error and
 * barrier timeout the mutant run is predeclared to show, case by case. A mutant that does not apply, changes another
 * file or does not typecheck, and a run with any technical error the manifest does not name, is a technical failure of
 * the gate, never a kill.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic, Evidence, Finding } from '../../spec/revocation/model';
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';

export const MUTANT_MANIFEST = 'mutations/revocation/manifest.json';
export type MutantEvidenceKind = 'decision_and_effect' | 'effect' | 'missing_evidence';
/**
 * What a witness's effect findings show, reported apart and never merged (approval-permit lifecycle plan section 8):
 *  - containment: something ran, was committed or delivered that must not (unexpected start, commit or delivery, or a
 *    side effect after the terminal);
 *  - lifecycle: an approval or a permit that must not exist (unexpected approval_granted or permit_issued); runtime
 *    state, never containment;
 *  - availability: an allowed action that did not happen (a missing start, commit, delivery, approval or permit);
 *  - signal: revocation signalling and terminal evidence (cancellation and revocation acknowledgements, a premature or
 *    unexpected terminal);
 *  - check_point: decision findings without any effect finding;
 *  - missing_evidence: no finding; the witness is UNASSESSABLE through missing evidence.
 * Component evidence does not exist in the eval gate (it observes the runtime through its public API only).
 */
export type EvidencePart = 'containment' | 'lifecycle' | 'availability' | 'signal' | 'check_point' | 'missing_evidence';
export const EVIDENCE_PARTS: readonly EvidencePart[] = ['containment', 'lifecycle', 'availability', 'signal', 'check_point', 'missing_evidence'];
const PART_OF_REASON: Record<string, EvidencePart> = {
  unexpected_execution_started: 'containment', unexpected_tool_commit: 'containment', unexpected_output_delivery: 'containment', tool_commit_after_terminal: 'containment', output_delivery_after_terminal: 'containment',
  unexpected_approval_granted: 'lifecycle', unexpected_permit_issued: 'lifecycle',
  missing_execution_started: 'availability', missing_tool_commit: 'availability', missing_output_delivery: 'availability', missing_approval_granted: 'availability', missing_permit_issued: 'availability',
  missing_cancellation_ack: 'signal', unexpected_cancellation_ack: 'signal', unexpected_execution_terminal: 'signal', missing_revocation_ack: 'signal', unexpected_revocation_ack: 'signal',
};
/** The evidence parts a witness shows, derived from its expected values alone (sorted, in EVIDENCE_PARTS order). */
export function witnessParts(w: Pick<Witness, 'verdict' | 'decision_findings' | 'effect_findings'>): EvidencePart[] {
  if (w.effect_findings.length === 0) return w.decision_findings.length ? ['check_point'] : w.verdict === 'UNASSESSABLE' ? ['missing_evidence'] : [];
  const parts = new Set(w.effect_findings.map(f => PART_OF_REASON[f.reason] ?? 'unknown'));
  if (parts.has('unknown' as EvidencePart)) return [];
  return EVIDENCE_PARTS.filter(p => parts.has(p));
}

export interface Witness {
  /** corpus: an IN_PROFILE corpus case; supplement: a supplement case. */
  set: 'corpus' | 'supplement';
  case_id: string;
  verdict: 'VIOLATION' | 'UNASSESSABLE';
  /** Exactly these decision findings (as a set). */
  decision_findings: Finding[];
  /** Exactly these effect findings (as a set). */
  effect_findings: Finding[];
  /** Exactly this incompleteness (as a set). */
  incomplete: string[];
  /** Exactly these evaluator error codes (as a set). */
  errors: string[];
  /** The run's exit code, and why it is that code. */
  exit: number;
  /** The run's has_confirmed_violation (distinguishes a detected exit 2 from a run without findings). */
  run_confirmed_violation: boolean;
  exit_reason: string;
}
export interface MutantSource { repository: string; commit: string; path: string; sha256: string }
/** An evaluator error of one case of the mutant run (its verdict is then HARNESS_ERROR). */
export interface RunHarnessError { case_id: string; code: string; path: string; message: string }
/** An adapter barrier timeout of one case of the mutant run. */
export interface RunBarrierTimeout { case_id: string; step: number | null; detail: string }
/**
 * Every technical exception the whole mutant run is predeclared to show, case by case and exactly: any other harness
 * error or barrier timeout anywhere in the run is a technical failure, and a predeclared one that does not occur is no
 * detection.
 */
export interface RunExceptions { harness_errors: RunHarnessError[]; barrier_timeouts: RunBarrierTimeout[] }
export interface RevocationMutant {
  id: string; patch: string; patch_sha256: string; target: string; description: string;
  /** Where a patch copied byte for byte from the pinned runtime's own mutant gate comes from; null for eval-side patches. */
  source: MutantSource | null;
  evidence_kind: MutantEvidenceKind;
  /** The evidence parts the witness shows (witnessParts of its expected values). */
  parts: EvidencePart[];
  /** Plan section 8.1 mutants: the plan's kind, and why the parts differ from it where they do. */
  plan_kind?: string;
  kind_note?: string;
  witness: Witness;
  run_exceptions: RunExceptions;
}
/**
 * A mutant whose change no case of the profile run can show under the pinned runtime mode: its whole run is pinned to
 * equal the control (exit, every case's evidence, no new diagnostic). It is a recorded gap, never a detection; a run
 * that differs from the control means the pin no longer holds and is a technical failure.
 */
export interface MaskedMutant {
  id: string; patch: string; patch_sha256: string; target: string; description: string; source: MutantSource | null;
  /** Why no case can show it, and what evidence of the check remains elsewhere. */
  reason: string;
  /** The witness it had under the previous pin, if any. */
  previous_witness: { set: 'corpus' | 'supplement'; case_id: string; pin: string } | null;
}
/** A plan mutant that is not run, with the concrete conflict and its reproduction (never evidence, never a detection). */
export interface NotRunMutant { id: string; plan_row: string; reason: string; reproduction: string }
export interface MutantManifest {
  manifest: string; version: string; sut_repository: string; sut_commit: string; profile: string; supplement: string;
  baseline: { exit: number; exit_reason: string };
  match: 'exact';
  evidence_kinds: Record<MutantEvidenceKind, string>;
  technical_failures: string;
  mutants: RevocationMutant[];
  masked: MaskedMutant[];
  not_run: NotRunMutant[];
}
export class MutantManifestError extends Error {}

const KINDS: MutantEvidenceKind[] = ['decision_and_effect', 'effect', 'missing_evidence'];
const HEX = /^[0-9a-f]{64}$/;

/** The evidence kind a witness shows, derived from its expected values alone. */
export function witnessKind(w: Pick<Witness, 'verdict' | 'decision_findings' | 'effect_findings'>): MutantEvidenceKind | null {
  if (w.verdict === 'UNASSESSABLE') return w.decision_findings.length === 0 && w.effect_findings.length === 0 ? 'missing_evidence' : null;
  if (w.effect_findings.length === 0) return null;
  return w.decision_findings.length ? 'decision_and_effect' : 'effect';
}

/**
 * Loads the mutant manifest fail-closed: golden SHA-256, the pinned SUT, profile and supplement of the lock, unique
 * ids, every patch bound by SHA-256 and changing exactly its target file (a copied patch equal to its source hash),
 * a declared evidence kind that
 * matches the expected values, and an exit code with its reason.
 */
export function loadMutantManifest(root: string, lock: { sut_repository: string; sut_commit: string; profile: string; supplement: string }, version: string): { manifest: MutantManifest; sha256: string } {
  const raw = readFileSync(join(root, MUTANT_MANIFEST));
  const sha256 = sha256Hex(raw);
  const golden = readFileSync(join(root, MUTANT_MANIFEST.replace(/\.json$/, '.sha256')), 'utf8').trim();
  if (sha256 !== golden) throw new MutantManifestError(`${MUTANT_MANIFEST} SHA-256 ${sha256} != golden ${golden}`);
  const m = JSON.parse(raw.toString('utf8')) as MutantManifest;
  const bad = (msg: string) => { throw new MutantManifestError(`${MUTANT_MANIFEST}: ${msg}`); };
  if (m.manifest !== 'revocation-sut-mutants/3' || m.version !== version || m.match !== 'exact') bad('unknown manifest format or version');
  if (m.sut_repository !== lock.sut_repository || m.sut_commit !== lock.sut_commit) bad(`bound to ${m.sut_repository}@${m.sut_commit}, not the locked SUT`);
  if (m.profile !== lock.profile || m.supplement !== lock.supplement) bad('bound to another profile or supplement than the lock');
  if (m.baseline?.exit !== 3 || !m.baseline.exit_reason) bad('baseline exit must be 3, with its reason');
  if (!Array.isArray(m.mutants) || m.mutants.length === 0) bad('no mutants');
  if (!Array.isArray(m.masked) || !Array.isArray(m.not_run)) bad('masked and not_run must be lists');
  const ids = new Set<string>();
  const checkPatch = (x: Pick<RevocationMutant, 'id' | 'patch' | 'patch_sha256' | 'target' | 'source'>) => {
    if (!/^M\d+$/.test(x.id) || ids.has(x.id)) bad(`invalid or duplicate mutant id ${x.id}`);
    ids.add(x.id);
    if (!/^[A-Za-z0-9.-]+\.patch$/.test(x.patch) || !/^src\/[A-Za-z0-9/-]+\.ts$/.test(x.target)) bad(`${x.id}: invalid patch or target path`);
    if (!HEX.test(x.patch_sha256)) bad(`${x.id}: invalid patch_sha256`);
    const bytes = readFileSync(join(root, 'mutations/revocation', x.patch));
    const actual = sha256Hex(bytes);
    if (actual !== x.patch_sha256) bad(`${x.id}: patch ${x.patch} SHA-256 ${actual} != ${x.patch_sha256}`);
    const changed = bytes.toString('utf8').split('\n').filter(l => l.startsWith('+++ ')).map(l => l.slice(4).trim().replace(/^b\//, ''));
    if (changed.length !== 1 || changed[0] !== x.target) bad(`${x.id}: patch changes ${JSON.stringify(changed)}, not exactly its target ${x.target}`);
    if (x.source !== null) {
      if (x.source.repository !== m.sut_repository || x.source.commit !== m.sut_commit || !/^mutants\/[a-z]+\/M\d+\.patch$/.test(x.source.path)) bad(`${x.id}: source must be a mutant patch of the pinned SUT`);
      if (x.source.sha256 !== x.patch_sha256) bad(`${x.id}: copied patch differs from its source ${x.source.path}`);
    }
  };
  for (const x of m.masked) {
    checkPatch(x);
    if (!x.reason || (x.previous_witness !== null && (!['corpus', 'supplement'].includes(x.previous_witness?.set) || !x.previous_witness.case_id || !x.previous_witness.pin))) bad(`${x.id}: a masked mutant needs its reason and a previous witness or null`);
  }
  for (const x of m.not_run) {
    if (!/^M\d+$/.test(x.id) || ids.has(x.id)) bad(`invalid or duplicate mutant id ${x.id}`);
    ids.add(x.id);
    if (!x.plan_row || !x.reason || !x.reproduction) bad(`${x.id}: a mutant that is not run needs its plan row, reason and reproduction`);
  }
  for (const x of m.mutants) {
    checkPatch(x);
    if (!KINDS.includes(x.evidence_kind)) bad(`${x.id}: unknown evidence kind ${x.evidence_kind}`);
    const w = x.witness;
    if (!w || !['corpus', 'supplement'].includes(w.set) || typeof w.case_id !== 'string') bad(`${x.id}: invalid witness`);
    if (!Array.isArray(w.incomplete) || !Array.isArray(w.errors) || !Number.isInteger(w.exit) || !w.exit_reason || typeof w.run_confirmed_violation !== 'boolean') bad(`${x.id}: witness needs exact incomplete, errors, exit, exit_reason and run_confirmed_violation`);
    if (witnessKind(w) !== x.evidence_kind) bad(`${x.id}: evidence kind ${x.evidence_kind} does not match its expected values (${witnessKind(w)})`);
    const parts = witnessParts(w);
    if (!parts.length || !Array.isArray(x.parts) || JSON.stringify(x.parts) !== JSON.stringify(parts)) bad(`${x.id}: evidence parts ${JSON.stringify(x.parts)} do not match its expected values (${JSON.stringify(parts)})`);
    if ((x.plan_kind === undefined) !== (x.kind_note === undefined)) bad(`${x.id}: plan_kind and kind_note go together`);
    const ex = x.run_exceptions;
    if (!ex || !Array.isArray(ex.harness_errors) || !Array.isArray(ex.barrier_timeouts)) bad(`${x.id}: run_exceptions must list harness_errors and barrier_timeouts`);
    for (const h of ex.harness_errors) if (!h || [h.case_id, h.code, h.path, h.message].some(v => typeof v !== 'string' || !v)) bad(`${x.id}: malformed predeclared harness error`);
    for (const t of ex.barrier_timeouts) if (!t || typeof t.case_id !== 'string' || !(t.step === null || Number.isInteger(t.step)) || typeof t.detail !== 'string' || !t.detail) bad(`${x.id}: malformed predeclared barrier timeout`);
    const witnessCodes = ex.harness_errors.filter(h => h.case_id === w.case_id).map(h => h.code).sort();
    if (JSON.stringify(witnessCodes) !== JSON.stringify([...w.errors].sort())) bad(`${x.id}: the witness errors differ from the run exceptions predeclared for ${w.case_id}`);
  }
  return { manifest: m, sha256 };
}

const key = (f: Finding) => `${f.reason}@${f.step}`;
const sameSet = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort()) && a.length === b.length;
/**
 * Whether the witness holds exactly for the witness case's evidence and the run's exit code: the verdict, the decision
 * and effect findings, the incompleteness and the evaluator errors each equal the manifest, and so does the exit.
 * Returns the reasons it does not.
 */
export function witnessFailures(w: Witness, e: Evidence | undefined, exit: number | undefined): string[] {
  if (!e) return [`witness case ${w.case_id} was not evaluated`];
  const out: string[] = [];
  if (e.verdict !== w.verdict) out.push(`verdict ${e.verdict} != ${w.verdict}`);
  if (!sameSet(e.errors.map(x => x.code), w.errors)) out.push(`errors ${JSON.stringify(e.errors.map(x => x.code))} != ${JSON.stringify(w.errors)}`);
  if (!sameSet(e.decision_findings.map(key), w.decision_findings.map(key))) out.push(`decision findings ${JSON.stringify(e.decision_findings.map(key))} != ${JSON.stringify(w.decision_findings.map(key))}`);
  if (!sameSet(e.effect_findings.map(key), w.effect_findings.map(key))) out.push(`effect findings ${JSON.stringify(e.effect_findings.map(key))} != ${JSON.stringify(w.effect_findings.map(key))}`);
  if (!sameSet(e.incomplete, w.incomplete)) out.push(`incomplete ${JSON.stringify(e.incomplete)} != ${JSON.stringify(w.incomplete)}`);
  if (exit !== undefined && exit !== w.exit) out.push(`exit ${exit} != ${w.exit}`);
  return out;
}

/** Adapter diagnostics that mean the harness process itself failed: never SUT behaviour, never predeclarable. */
export const HARNESS_PROCESS_CODES: ReadonlySet<string> = new Set(['adapter_abort', 'setup_failed', 'constructor_getter_ran']);

/** What the gate needs of one complete profile run: every evaluated case, every adapter diagnostic, exit and flag. */
export interface RunFacts {
  cases: Map<string, Evidence>;
  diagnostics: (Diagnostic & { case_id: string })[];
  exit: number;
  confirmed_violation: boolean;
}
export type MutantOutcome = 'detected' | 'survived' | 'technical_failure';

/** Items of `actual` not matched one for one by `expected` (multiset difference). */
function unmatched<T>(actual: T[], expected: T[]): T[] {
  const pool = expected.map(x => canonicalJson(x));
  return actual.filter(x => { const i = pool.indexOf(canonicalJson(x)); if (i < 0) return true; pool.splice(i, 1); return false; });
}
export const runHarnessErrors = (r: RunFacts): RunHarnessError[] => [...r.cases].flatMap(([case_id, e]) => e.errors.map(x => ({ case_id, code: x.code, path: x.path, message: x.message })));
export const runBarrierTimeouts = (r: RunFacts): RunBarrierTimeout[] => r.diagnostics.filter(d => d.code === 'barrier_timeout').map(d => ({ case_id: d.case_id, step: d.step, detail: d.detail }));

/**
 * The technical errors of a whole profile run that a manifest entry does not predeclare: a case inventory other than
 * the control's, any harness process diagnostic, and every harness error or barrier timeout, in any case, beyond the
 * entry's run_exceptions. Without an entry (the control) nothing is predeclared.
 */
export function unexpectedTechnical(run: RunFacts, control: RunFacts | null, ex: RunExceptions = { harness_errors: [], barrier_timeouts: [] }): string[] {
  const out: string[] = [];
  if (control && JSON.stringify([...run.cases.keys()].sort()) !== JSON.stringify([...control.cases.keys()].sort())) out.push('case inventory differs from the control');
  for (const d of run.diagnostics) if (HARNESS_PROCESS_CODES.has(d.code)) out.push(`harness process error ${d.case_id}@${d.step}: ${d.code}: ${d.detail}`);
  for (const h of unmatched(runHarnessErrors(run), ex.harness_errors)) out.push(`unexpected harness error ${h.case_id} ${h.code}: ${h.path} ${h.message}`);
  for (const t of unmatched(runBarrierTimeouts(run), ex.barrier_timeouts)) out.push(`unexpected barrier timeout ${t.case_id}@${t.step}: ${t.detail}`);
  return out;
}

const sameEvidence = (a: Evidence | undefined, b: Evidence | undefined) => !!a && !!b && canonicalJson({ ...a, case_id: '' }) === canonicalJson({ ...b, case_id: '' });

/**
 * Classifies the run of a masked mutant: its whole run must equal the control (the case inventory and every case's
 * evidence, the exit, has_confirmed_violation and the diagnostics). Anything else means the masking pin no longer
 * holds: a technical failure, never a detection.
 */
export function classifyMaskedRun(run: RunFacts, control: RunFacts): { outcome: 'masked' | 'technical_failure'; differences: string[] } {
  const differences: string[] = [...unexpectedTechnical(run, control)];
  for (const [id, e] of run.cases) if (!sameEvidence(e, control.cases.get(id))) differences.push(`case ${id} differs from the control (${e.verdict})`);
  if (run.exit !== control.exit) differences.push(`exit ${run.exit} != control ${control.exit}`);
  if (run.confirmed_violation !== control.confirmed_violation) differences.push('has_confirmed_violation differs from the control');
  if (canonicalJson(run.diagnostics) !== canonicalJson(control.diagnostics)) differences.push('diagnostics differ from the control');
  return { outcome: differences.length ? 'technical_failure' : 'masked', differences };
}

/**
 * Classifies one mutant run. The whole run is checked for technical errors first: any the manifest entry does not
 * predeclare makes it a technical failure, whatever its witness shows. Only then is it detected (the witness, the
 * run's exit and has_confirmed_violation exactly as fixed, and every predeclared exception present) or survived (the
 * witness case and the exit exactly the control's). Anything else is a technical failure too: never a kill.
 */
export function classifyMutantRun(m: Pick<RevocationMutant, 'witness' | 'run_exceptions'>, run: RunFacts, control: RunFacts): { outcome: MutantOutcome; technical: string[]; failures: string[] } {
  const technical = unexpectedTechnical(run, control, m.run_exceptions);
  const e = run.cases.get(m.witness.case_id);
  const failures = witnessFailures(m.witness, e, run.exit);
  if (run.confirmed_violation !== m.witness.run_confirmed_violation) failures.push(`has_confirmed_violation ${run.confirmed_violation} != ${m.witness.run_confirmed_violation}`);
  for (const h of unmatched(m.run_exceptions.harness_errors, runHarnessErrors(run))) failures.push(`predeclared harness error missing: ${h.case_id} ${h.code}`);
  for (const t of unmatched(m.run_exceptions.barrier_timeouts, runBarrierTimeouts(run))) failures.push(`predeclared barrier timeout missing: ${t.case_id}@${t.step}`);
  if (technical.length) return { outcome: 'technical_failure', technical, failures };
  if (failures.length === 0) return { outcome: 'detected', technical, failures };
  if (run.exit === control.exit && sameEvidence(e, control.cases.get(m.witness.case_id))) return { outcome: 'survived', technical, failures };
  return { outcome: 'technical_failure', technical: ['witness values are neither the control\'s nor the manifest\'s'], failures };
}
