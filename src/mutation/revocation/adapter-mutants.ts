/**
 * Adapter mutants AM1-AM10 (docs/revocation/runtime-adapter-compatibility.md, section 10). Each check runs the
 * adapter with one deliberate defect against a real pinned runtime build (or applies the defect to a real observation
 * where the defect needs SUT behaviour the baseline runtime does not show) and states how the defect is detected.
 */
import { Case, Evidence, Expected, ProbeState, RuntimeObservation } from '../../spec/revocation/model';
import { evaluate } from '../../eval/revocation/evaluate';
import { runProfile } from '../../eval/revocation/runtime-run';
import { AdapterCase, AdapterFault, capabilityIdFor, report, requestDisciplineIssues, sessionDisciplineIssues } from '../../adapter/revocation-runtime/runner';
import { controlSteps, Profile, Supplement } from '../../profile/revocation/profile';
import { MUTANTS, witnessFailures } from './mutants';
import { commitValueJson } from '../../spec/revocation/runtime-observation';

export interface AdapterMutantResult { id: AdapterFault; detected: boolean; how: string }

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** Re-reports an observation from its own probes and calls, as the adapter would (optionally with a reporting defect). */
export function rereport(c: AdapterCase, o: RuntimeObservation, fault?: AdapterFault): RuntimeObservation {
  const control = new Set(controlSteps(c));
  const traces = new Map<string, { authority: string; label: string }>();
  for (const p of o.probes) for (const e of p.state.entries) traces.set(e.label, { authority: e.request_authority, label: e.label });
  const { decisions, effects } = report(c, o.probes, o.calls, o.identity, control, { fault }, [], traces);
  return { ...o, decisions, effects };
}
/** Applies `edit` to the probe states from probe index `from` onwards (simulating SUT state the baseline does not show). */
export function editProbes(o: RuntimeObservation, from: number, edit: (s: ProbeState) => void): RuntimeObservation {
  const out = clone(o);
  out.probes.forEach((p, k) => { if (k >= from) edit(p.state); });
  return out;
}
/** Simulated SUT state: commit attempt n of `label` written (key, written value, version growth), as the runtime would show it. */
export function writeCommit(s: ProbeState, label: string, n: number): void {
  s.managed.push({ key: `ace:${label}#${n}`, label, n, value_json: commitValueJson(label, n) });
  s.managed_version += 1;
}
/** Simulated SUT state: `label`'s execution terminal with its own record and one terminal-log entry. */
export function markTerminal(s: ProbeState, label: string, outcome = 'failed'): void {
  for (const x of s.executions) if (x.label === label) {
    x.state = 'terminal';
    x.terminal = { execution_id: x.execution_id, outcome };
    if (!s.terminals.some(t => t.execution_id === x.execution_id)) s.terminals.push({ execution_id: x.execution_id, outcome });
  }
}
export const probeIndex = (o: RuntimeObservation, step: number, point: string) => o.probes.findIndex(p => p.step === step && p.point === point);
const ev = (c: Case, truth: Expected, o: RuntimeObservation) => evaluate(c, truth, o, { ordering: 'probe_seq', controlSteps: controlSteps(c) });
const codes = (e: Evidence) => e.errors.map(x => x.code);

export async function adapterMutantChecks(builds: { baseline: string; m10?: string; m11?: string }, cases: Case[], truths: Expected[], profile: Profile, supplement: Supplement): Promise<AdapterMutantResult[]> {
  const caseOf = (id: string) => { const i = cases.findIndex(c => c.id === id); return { c: cases[i], truth: truths[i] }; };
  const one = (id: string) => (x: string) => x === id;
  const out: AdapterMutantResult[] = [];
  const add = (id: AdapterFault, detected: boolean, how: string) => out.push({ id, detected, how });

  // AM1: back-filling from the oracle. A watchdog of 0 ms leaves decisions UNKNOWN; AM1 fills them from the oracle.
  {
    const plain = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('commit-before-cut'), watchdogMs: 0 })).corpus[0].evidence;
    const am = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('commit-before-cut'), watchdogMs: 0, fault: 'AM1_backfill_from_oracle' })).corpus[0].evidence;
    add('AM1_backfill_from_oracle', codes(am).includes('decision_without_evidence') && am.verdict !== 'PASS' && plain.verdict !== 'PASS', `without AM1: ${plain.verdict}; with AM1: ${am.verdict} [${codes(am).join(',')}]`);
  }
  // AM2: decisions reported for finish/seal.
  {
    const e = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('cut-before-start'), fault: 'AM2_report_control_decisions' })).corpus[0].evidence;
    add('AM2_report_control_decisions', codes(e).includes('decision_at_control_step'), `${e.verdict} [${codes(e).join(',')}]`);
  }
  // AM3: attribution by intended authority. The runtime binding of the sibling's execution is replaced by the child's
  // capability in the observed state (a runtime binding the baseline does not show); the correct report must not PASS
  // and the AM3 report is rejected against the probe log.
  {
    const { c, truth } = caseOf('sibling-isolation');
    const base = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one(c.id) })).corpus[0].run.observation;
    const childCap = capabilityIdFor(c.id, 'child');
    const swapped = editProbes(base, 0, s => { for (const x of s.executions) if (x.label === 'e3') x.capability_id = childCap; });
    const correct = ev(c, truth, rereport(c, swapped));
    const am = ev(c, truth, rereport(c, swapped, 'AM3_attribute_by_intent'));
    add('AM3_attribute_by_intent', correct.verdict !== 'PASS' && am.verdict === 'HARNESS_ERROR' && codes(am).some(x => x === 'effect_without_probe_evidence' || x === 'sequence_inconsistent'), `correct report on mismatched binding: ${correct.verdict}; AM3: ${am.verdict} [${codes(am).join(',')}]`);
  }
  // AM4: a fixed microtask count instead of the deliver barrier.
  {
    const e = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('commit-before-cut'), fault: 'AM4_microtask_deliver_barrier' })).corpus[0].evidence;
    add('AM4_microtask_deliver_barrier', e.verdict !== 'PASS' && e.incomplete.some(x => x.startsWith('effect observed outside a step barrier')), `${e.verdict} [${e.incomplete.join('; ')}]`);
  }
  // AM5: lock release (or whenTerminal) taken as terminal evidence: on S4 and, when available, on M10.
  {
    const s4 = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('sup-unobservable-pending-settlement'), fault: 'AM5_terminal_from_lock_release' })).supplement[0].evidence;
    let m10 = 'M10 build not available';
    let m10ok = true;
    if (builds.m10) {
      const e = (await runProfile(builds.m10, cases, truths, profile, supplement, { only: one('start-before-cut'), fault: 'AM5_terminal_from_lock_release' })).corpus[0].evidence;
      m10ok = e.verdict !== 'PASS';
      m10 = `M10 start-before-cut: ${e.verdict} [${codes(e).join(',')}]`;
    }
    add('AM5_terminal_from_lock_release', s4.verdict !== 'PASS' && codes(s4).includes('effect_without_probe_evidence') && m10ok, `S4: ${s4.verdict} [${codes(s4).join(',')}]; ${m10}`);
  }
  // AM6: a commit effect dropped because the commit call threw. The state change is injected at the denied commit of
  // in-flight-before-commit (a DENY with a write the baseline does not show).
  {
    const { c, truth } = caseOf('in-flight-before-commit');
    const base = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one(c.id) })).corpus[0].run.observation;
    const written = editProbes(base, probeIndex(base, 3, 'barrier_complete'), s => writeCommit(s, 'e1', 1));
    const correct = ev(c, truth, rereport(c, written));
    const am = ev(c, truth, rereport(c, written, 'AM6_drop_commit_on_throw'));
    add('AM6_drop_commit_on_throw', correct.effect_findings.some(f => f.reason === 'unexpected_tool_commit' && f.step === 3) && codes(am).includes('effect_not_reported'), `correct report: ${correct.verdict} ${JSON.stringify(correct.effect_findings)}; AM6: ${am.verdict} [${codes(am).join(',')}]`);
  }
  // AM7: a signed request re-submitted for a later start.
  {
    const r = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('issued-permit'), fault: 'AM7_resubmit_request' })).corpus[0];
    const issues = requestDisciplineIssues(r.run);
    add('AM7_resubmit_request', issues.length > 0, `${issues.join('; ')}; evidence ${r.evidence.verdict}`);
  }
  // AM8: each authority in its own runtime session.
  {
    const r = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('active-session'), fault: 'AM8_session_per_authority' })).corpus[0];
    const issues = sessionDisciplineIssues({ id: r.c.id, authorities: r.c.authorities, steps: r.c.steps }, r.run.observation);
    add('AM8_session_per_authority', issues.length > 0, issues.join('; '));
  }
  // AM9: seq assigned after the run.
  {
    const e = (await runProfile(builds.baseline, cases, truths, profile, supplement, { only: one('in-flight-before-commit'), fault: 'AM9_seq_by_array_order' })).corpus[0].evidence;
    add('AM9_seq_by_array_order', e.verdict === 'HARNESS_ERROR' && codes(e).some(x => x === 'sequence_inconsistent' || x === 'effect_without_probe_evidence'), `${e.verdict} [${codes(e).join(',')}]`);
  }
  // AM10: no probe inside the tool double's entry function: M11's witness on S4 must then fail.
  {
    if (!builds.m11) add('AM10_no_entry_probe', false, 'M11 build not available');
    else {
      const r = await runProfile(builds.m11, cases, truths, profile, supplement, { only: one('sup-unobservable-pending-settlement'), fault: 'AM10_no_entry_probe' });
      const e = r.supplement[0].evidence;
      const m11 = MUTANTS.find(m => m.id === 'M11')!;
      const failures = witnessFailures({ ...m11.witness, exit: undefined }, e, 0);
      add('AM10_no_entry_probe', failures.length > 0 && e.incomplete.some(x => x.startsWith('effect order not established')), `M11 S4 under AM10: ${e.verdict}; witness fails: ${failures.join('; ')}`);
    }
  }
  return out;
}
