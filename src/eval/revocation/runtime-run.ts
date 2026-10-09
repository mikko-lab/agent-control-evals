import { Case, Evidence, Expected, RuntimeObservation } from '../../spec/revocation/model';
import { evaluate } from './evaluate';
import { loadRevocationSut } from '../../adapter/revocation-runtime/sut';
import { AdapterFault, runCase, RunResult } from '../../adapter/revocation-runtime/runner';
import { controlSteps, Profile, Supplement, SupplementCase } from '../../profile/revocation/profile';

export interface ProfileRun {
  corpus: { c: Case; truth: Expected; run: RunResult; evidence: Evidence }[];
  supplement: { c: SupplementCase; run: RunResult; evidence: Evidence }[];
}

/**
 * Drives the pinned runtime build over the IN_PROFILE corpus cases and the supplement, strictly sequentially, and
 * evaluates each observation in probe_seq mode with its harness control steps. OUT_OF_SCOPE cases are never run.
 * Expectations are computed before and passed in; the adapter itself never receives them (except the AM1 defect).
 */
export async function runProfile(build: string, cases: Case[], truths: Expected[], profile: Profile, supplement: Supplement, o: { fault?: AdapterFault; only?: (id: string) => boolean; watchdogMs?: number } = {}): Promise<ProfileRun> {
  const sut = loadRevocationSut(build);
  const out: ProfileRun = { corpus: [], supplement: [] };
  for (let i = 0; i < cases.length; i++) {
    const p = profile.cases[i];
    if (p.applicability !== 'IN_PROFILE' || (o.only && !o.only(p.id))) continue;
    const c = cases[i];
    const run = await runCase({ id: c.id, authorities: c.authorities, steps: c.steps }, sut, { watchdogMs: o.watchdogMs ?? profile.barrier_watchdog_ms, controlSteps: p.not_assessed_requirements, fault: o.fault, oracle: o.fault === 'AM1_backfill_from_oracle' ? truths[i] : undefined });
    out.corpus.push({ c, truth: truths[i], run, evidence: evaluate(c, truths[i], run.observation, { ordering: 'probe_seq', controlSteps: p.not_assessed_requirements }) });
  }
  for (const s of supplement.cases) {
    if (o.only && !o.only(s.id)) continue;
    const control = controlSteps(s);
    const run = await runCase({ id: s.id, authorities: s.authorities, steps: s.steps, setup: s.setup, approve_starts: s.approve_starts, double: s.double }, sut, { watchdogMs: o.watchdogMs ?? profile.barrier_watchdog_ms, controlSteps: control, fault: o.fault, oracle: o.fault === 'AM1_backfill_from_oracle' ? s.expected : undefined });
    const c: Case = { id: s.id, family: s.family, authorities: s.authorities, steps: s.steps };
    out.supplement.push({ c: s, run, evidence: evaluate(c, s.expected, run.observation, { ordering: 'probe_seq', controlSteps: control }) });
  }
  return out;
}

export const observationsOf = (r: ProfileRun): { corpus: RuntimeObservation[]; supplement: RuntimeObservation[] } => ({ corpus: r.corpus.map(x => x.run.observation), supplement: r.supplement.map(x => x.run.observation) });
