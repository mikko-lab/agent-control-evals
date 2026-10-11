/**
 * SUT mutants of the revocation track's pinned runtime (docs/revocation/runtime-adapter-compatibility.md, section 10).
 * Each is one type-safe patch of one file of the pinned acs-guardrail-demo tree under mutations/revocation/, applied to
 * a fresh checkout. Patches, witnesses, exact expected values and evidence kinds are fixed in the committed, golden-
 * hashed manifest mutations/revocation/manifest.json before any mutant run. A mutant that does not apply, changes
 * another file or does not typecheck is a technical failure of the gate, never a kill.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence, Finding } from '../../spec/revocation/model';
import { sha256Hex } from '../../util/hash';

export const MUTANT_MANIFEST = 'mutations/revocation/manifest.json';
export type MutantEvidenceKind = 'decision_and_effect' | 'effect' | 'missing_evidence';

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
export interface RevocationMutant {
  id: string; patch: string; patch_sha256: string; target: string; description: string;
  /** Where a patch copied byte for byte from the pinned runtime's own mutant gate comes from; null for eval-side patches. */
  source: MutantSource | null;
  evidence_kind: MutantEvidenceKind;
  witness: Witness;
}
export interface MutantManifest {
  manifest: string; version: string; sut_repository: string; sut_commit: string; profile: string; supplement: string;
  baseline: { exit: number; exit_reason: string };
  match: 'exact';
  evidence_kinds: Record<MutantEvidenceKind, string>;
  technical_failures: string;
  mutants: RevocationMutant[];
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
  if (m.manifest !== 'revocation-sut-mutants/2' || m.version !== version || m.match !== 'exact') bad('unknown manifest format or version');
  if (m.sut_repository !== lock.sut_repository || m.sut_commit !== lock.sut_commit) bad(`bound to ${m.sut_repository}@${m.sut_commit}, not the locked SUT`);
  if (m.profile !== lock.profile || m.supplement !== lock.supplement) bad('bound to another profile or supplement than the lock');
  if (m.baseline?.exit !== 3 || !m.baseline.exit_reason) bad('baseline exit must be 3, with its reason');
  if (!Array.isArray(m.mutants) || m.mutants.length === 0) bad('no mutants');
  const ids = new Set<string>();
  for (const x of m.mutants) {
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
    if (!KINDS.includes(x.evidence_kind)) bad(`${x.id}: unknown evidence kind ${x.evidence_kind}`);
    const w = x.witness;
    if (!w || !['corpus', 'supplement'].includes(w.set) || typeof w.case_id !== 'string') bad(`${x.id}: invalid witness`);
    if (!Array.isArray(w.incomplete) || !Array.isArray(w.errors) || !Number.isInteger(w.exit) || !w.exit_reason || typeof w.run_confirmed_violation !== 'boolean') bad(`${x.id}: witness needs exact incomplete, errors, exit, exit_reason and run_confirmed_violation`);
    if (witnessKind(w) !== x.evidence_kind) bad(`${x.id}: evidence kind ${x.evidence_kind} does not match its expected values (${witnessKind(w)})`);
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
