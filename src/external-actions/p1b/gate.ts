/**
 * P1b XM mutant gate (decisions, "Gate"): builds each mutant from its confined patch and checks the whole run of the
 * control and of every mutant against the declared assertions and the exact pins.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { singleCaseExit } from '../eval/evaluate';
import type { Report } from '../report/report';
import { Pin, pinOf } from '../self-test';
import type { Evidence } from '../spec/model';
import { loadP1bProfile, loadRunConfig, P1B_PATHS } from './config';
import { patchIssues } from './patch';

export const MUTANT_RULES: Record<string, string> = {
  XM5: 'authorize', XM6a: 'classify', XM6b: 'classify', XM7: 'authorize', XM9: 'dedup', XM10: 'report', XM11: 'authorize', XM12: 'forward_gate', XM13a: 'forward_gate', XM13b: 'forward_gate',
};

/** The guard source for `reference` or an XM id; a mutant's patch must be confined to its rule. */
export function guardSource(root: string, id: string): string {
  const reference = readFileSync(join(root, P1B_PATHS.guard), 'utf8');
  if (id === 'reference') return reference;
  const rule = MUTANT_RULES[id];
  if (!rule) throw new Error(`unknown guard mutant ${id}`);
  const r = patchIssues(reference, readFileSync(join(root, P1B_PATHS.patches, `${id}.patch`), 'utf8'), rule);
  if (!r.mutated) throw new Error(`mutant ${id} rejected: ${r.issues.join('; ')}`);
  return r.mutated;
}

// ---------------------------------------------------------------- gate

export interface WitnessAssertion {
  case_id: string; verdict: string;
  decision_findings_include?: string[]; effect_findings_include?: string[];
  decision_findings_exact?: string[]; effect_findings_exact?: string[]; incomplete_flags_include?: string[];
}
export interface Deviation { case_id: string; kind: 'technical' | 'T_q_overrun'; codes?: string[] }
export interface MutantEntry {
  id: string; rule: string; patch: string; patch_sha256: string; fault: string; evidence_kind: string;
  witnesses: WitnessAssertion[]; masked: boolean; pins: Record<string, Pin> | null; deviations: Deviation[];
}
export interface GateManifest {
  format: 'external-action-guard-mutants/1';
  reference_guard: { path: string; sha256: string };
  profile_sha256: string; run_config_sha256: string;
  run_assertions: { control: { all_pass: boolean; exit_code: number }; XM11: { profile_acceptance_passed: boolean } };
  control_pins: Record<string, Pin> | null;
  mutants: MutantEntry[];
}
export interface RunSummary { manifest: { guard: { id: string; sha256: string }; profile_sha256: string; run_config_sha256: string; development_subset: unknown; environment_ok: boolean; injections: string[] }; evidence: Evidence[]; report: Report }

export function loadRun(dir: string): RunSummary | null {
  try {
    return {
      manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
      evidence: readFileSync(join(dir, 'evidence.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
      report: JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')),
    };
  } catch { return null; }
}

/** An assertion item matches a pinned finding of the same class at the same place; `:late` in the assertion requires lateness. */
const matches = (want: string, have: string[]) => have.includes(want) || (!want.endsWith(':late') && have.includes(`${want}:late`));
const executorTimeout = (e: Evidence) => e.closure.notes.some(n => n.startsWith('executor quiescence not confirmed'));

export interface GateResult {
  passed: boolean;
  issues: string[];
  control: { pins: Record<string, Pin> };
  mutants: { id: string; rule: string; evidence_kind: string; masked: boolean; witnesses: { case_id: string; ok: boolean; pin: Pin | null; problems: string[] }[]; changed_cases: string[]; deviations_observed: Deviation[]; pins: Record<string, Pin>; ok: boolean }[];
}

/** The whole-run gate. With `precheck`, pins are reported but never taken from the run. */
export function runGate(root: string, manifest: GateManifest, runs: Record<string, RunSummary | null>, precheck = false): GateResult {
  const issues: string[] = [];
  const { profile, sha256: profileSha } = loadP1bProfile(root);
  const { sha256: configSha } = loadRunConfig(root);
  const reference = readFileSync(join(root, P1B_PATHS.guard), 'utf8');
  if (manifest.format !== 'external-action-guard-mutants/1') issues.push('unknown manifest format');
  if (manifest.reference_guard.sha256 !== sha256Hex(reference)) issues.push('the reference guard differs from the manifest');
  if (manifest.profile_sha256 !== profileSha || manifest.run_config_sha256 !== configSha) issues.push('the manifest does not bind the pinned P1b profile and run configuration');
  // Inventory: exactly the named mutants, each patch pinned and confined to its rule.
  const ids = manifest.mutants.map(m => m.id);
  if (ids.length === 0) issues.push('no mutants');
  if (ids.slice().sort().join(',') !== Object.keys(MUTANT_RULES).sort().join(',') || new Set(ids).size !== ids.length) issues.push(`mutant inventory ${ids.join(',')} differs from ${Object.keys(MUTANT_RULES).join(',')}`);
  for (const k of Object.keys(runs)) if (k !== 'reference' && !ids.includes(k)) issues.push(`a run of unknown guard ${k}`);
  const checkRun = (id: string, r: RunSummary | null, expectSha: string): r is RunSummary => {
    if (!r) { issues.push(`run of ${id} missing`); return false; }
    if (r.manifest.guard.id !== id || r.manifest.guard.sha256 !== expectSha) issues.push(`run of ${id} used another guard (${r.manifest.guard.id} ${r.manifest.guard.sha256})`);
    if (r.manifest.profile_sha256 !== profileSha || r.manifest.development_subset !== null || r.manifest.run_config_sha256 !== configSha) issues.push(`run of ${id} did not use the pinned full profile and run configuration`);
    if (r.manifest.injections.length) issues.push(`run of ${id} used injections`);
    if (!r.manifest.environment_ok) issues.push(`run of ${id}: environment check failed`);
    if (r.evidence.length !== profile.cases.length || profile.cases.some(c => !r.evidence.some(e => e.case_id === c))) issues.push(`run of ${id} does not cover the profile`);
    return true;
  };
  const pinsOf = (r: RunSummary) => Object.fromEntries(profile.cases.map(c => { const e = r.evidence.find(x => x.case_id === c); return [c, e ? pinOf(e, singleCaseExit(e)) : null]; })) as Record<string, Pin>;
  const control = runs.reference ?? null;
  let controlPins: Record<string, Pin> = {};
  if (checkRun('reference', control, sha256Hex(reference))) {
    controlPins = pinsOf(control);
    if (!(control.report.technically_valid && control.report.counts.PASS === profile.cases.length && control.report.exit_code === manifest.run_assertions.control.exit_code)) issues.push(`control run is not all PASS with exit ${manifest.run_assertions.control.exit_code} (exit ${control.report.exit_code})`);
    if (!precheck) { if (!manifest.control_pins) issues.push('control pins missing'); else if (canonicalJson(manifest.control_pins) !== canonicalJson(controlPins)) issues.push('control run differs from its pins'); }
  }
  const mutants: GateResult['mutants'] = [];
  for (const m of manifest.mutants) {
    const mi: string[] = [];
    if (MUTANT_RULES[m.id] !== m.rule) mi.push(`rule ${m.rule} is not the rule of ${m.id}`);
    let patch = '';
    try { patch = readFileSync(join(root, m.patch), 'utf8'); } catch { mi.push('patch missing'); }
    if (sha256Hex(patch) !== m.patch_sha256) mi.push('patch differs from its pin');
    const confined = patchIssues(reference, patch, m.rule);
    mi.push(...confined.issues);
    const r = runs[m.id] ?? null;
    const entry: GateResult['mutants'][number] = { id: m.id, rule: m.rule, evidence_kind: m.evidence_kind, masked: false, witnesses: [], changed_cases: [], deviations_observed: [], pins: {}, ok: false };
    if (confined.mutated && checkRun(m.id, r, sha256Hex(confined.mutated))) {
      const pins = pinsOf(r);
      entry.pins = pins;
      entry.changed_cases = profile.cases.filter(c => canonicalJson(pins[c]) !== canonicalJson(controlPins[c]));
      entry.masked = entry.changed_cases.length === 0;
      if (entry.masked && !m.masked) mi.push('masked: no case differs from the control');
      for (const c of profile.cases) {
        const e = r.evidence.find(x => x.case_id === c)!;
        if (e.verdict === 'HARNESS_ERROR') entry.deviations_observed.push({ case_id: c, kind: 'technical', codes: [...new Set(e.errors.map(x => x.code))].sort() });
        if (executorTimeout(e)) entry.deviations_observed.push({ case_id: c, kind: 'T_q_overrun' });
      }
      // Only exactly named, pinned deviations; anything else is a technical failure of the run.
      if (!precheck && canonicalJson(entry.deviations_observed) !== canonicalJson(m.deviations)) mi.push(`deviations ${JSON.stringify(entry.deviations_observed)} differ from the pinned ${JSON.stringify(m.deviations)}`);
      if (!precheck) { if (!m.pins) mi.push('pins missing'); else for (const c of profile.cases) if (canonicalJson(m.pins[c]) !== canonicalJson(pins[c])) mi.push(`case ${c} differs from its pin`); }
      for (const w of m.witnesses) {
        const p = pins[w.case_id] ?? null;
        const problems: string[] = [];
        if (!p) problems.push('no result');
        else {
          if (p.verdict !== w.verdict) problems.push(`verdict ${p.verdict}, required ${w.verdict}`);
          for (const x of w.decision_findings_include ?? []) if (!matches(x, p.decision_findings)) problems.push(`decision finding ${x} missing`);
          for (const x of w.effect_findings_include ?? []) if (!matches(x, p.effect_findings)) problems.push(`effect finding ${x} missing`);
          if (w.decision_findings_exact && canonicalJson(p.decision_findings) !== canonicalJson([...w.decision_findings_exact].sort())) problems.push(`decision findings ${p.decision_findings.join(',')} are not exactly ${w.decision_findings_exact.join(',')}`);
          if (w.effect_findings_exact && canonicalJson(p.effect_findings) !== canonicalJson([...w.effect_findings_exact].sort())) problems.push(`effect findings ${p.effect_findings.join(',')} are not exactly ${w.effect_findings_exact.join(',')}`);
          for (const f of w.incomplete_flags_include ?? []) if (!p.incomplete.some(x => x.endsWith(`/${f}`))) problems.push(`no incompleteness flagged ${f}`);
          if (p.errors.length) problems.push(`technical errors beside the witness: ${p.errors.join(',')}`);
        }
        entry.witnesses.push({ case_id: w.case_id, ok: problems.length === 0, pin: p, problems });
        if (problems.length) mi.push(`witness ${w.case_id}: ${problems.join('; ')}`);
      }
      if (m.id === 'XM11' && r.report.profile_acceptance_passed !== manifest.run_assertions.XM11.profile_acceptance_passed) mi.push('deny-all passes the profile');
    } else if (!confined.mutated) mi.push('the mutant could not be built');
    entry.ok = mi.length === 0;
    issues.push(...mi.map(x => `${m.id}: ${x}`));
    mutants.push(entry);
  }
  return { passed: !precheck && issues.length === 0, issues, control: { pins: controlPins }, mutants };
}
