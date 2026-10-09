import { canonicalJson } from '../../util/canonical-json';
import { Case, Decision, Effect, EffectKind, Evidence, Expected, ExpectedEffect, RuntimeObservation } from '../../spec/revocation/model';
import { observationIssues, runtimeObservationIssues } from '../../report/revocation/validate';
import { decisionFromCall, derive, effectSlot, probeLogIssues, DECISION_PROVENANCE, EFFECT_PROVENANCE } from '../../spec/revocation/runtime-observation';

const EXECUTION_KINDS = new Set(['execution_started', 'tool_commit', 'output_delivery', 'cancellation_ack', 'execution_terminal']);
const NEEDS_START = new Set(['tool_commit', 'output_delivery', 'cancellation_ack', 'execution_terminal']);
const ITEM = /^\/(decisions|effects)\/(\d+)(\/|$)/;

/** Occurrence step admissible for an expected effect: exact step, or the terminal window from finish request to seal. */
export function withinWindow(step: number, expected: ExpectedEffect): boolean {
  return step >= expected.earliest && step <= expected.latest;
}

/**
 * Evaluation options (revocation-0.4.0). `step` is the unchanged 0.3.0 path. `probe_seq` evaluates a pinned runtime
 * adapter observation: effects are ordered by (step, seq), the report is checked against the probe log and call
 * records, and the decisions of `controlSteps` (finish, seal) are harness control: not assessed and never reported.
 */
export interface EvaluateOptions { ordering?: 'step' | 'probe_seq'; controlSteps?: readonly number[] }

/**
 * Contradictory state evidence of one fact (probe_seq mode): the effect kind and execution it concerns (null when the
 * fact names no observed execution) and the steps between which it can have occurred (from the probe before its first
 * contradictory probe to that probe). It leaves unconfirmed only expected effects of that kind and execution whose
 * window meets those steps; it is never evidence about any other effect.
 */
export interface EvidenceGap { kind: EffectKind; execution: string | null; from: number; to: number }
const gapCovers = (g: EvidenceGap, kind: EffectKind, execution: string | null, earliest: number, latest: number) =>
  g.kind === kind && (g.execution === null || g.execution === execution) && g.from <= latest && g.to >= earliest;

const sameIdentity = (f: Effect, x: ExpectedEffect) => f.kind === x.kind && f.authority === x.authority && f.execution === x.execution && canonicalJson(f.target) === canonicalJson(x.target);
const executionKey = (f: Effect) => `${f.authority}/${f.execution}`;

/**
 * Expected truth is passed in after precomputation, never derived from observations.
 * Malformed or unattributable items and causally impossible traces are HARNESS_ERRORs, but every remaining
 * well-formed attributable item is still evaluated and its findings are retained beside the errors.
 */
export function evaluate(c: Case, truth: Expected, input: unknown, options: EvaluateOptions = {}): Evidence {
  const probeMode = options.ordering === 'probe_seq';
  const control = new Set(options.controlSteps ?? []);
  const e: Evidence = { case_id: c.id, family: c.family, state_at_cut: truth.cuts, verdict: 'PASS', confirmed_violation: false, decision_findings: [], effect_findings: [], incomplete: [], errors: [] };
  const error = (code: string, path: string, message: string) => e.errors.push({ code, path, message });
  const issues = probeMode ? runtimeObservationIssues(input) : observationIssues(input);
  const fatal = issues.filter(i => !ITEM.test(i.path));
  if (fatal.length) { for (const i of fatal) error('malformed_observation', i.path || '/', i.message); return finish(e); }
  const o = input as { case_id: string; complete: boolean; decisions: unknown[]; effects: unknown[] };
  if (o.case_id !== c.id) { error('case_identity_mismatch', '/case_id', `observation for ${JSON.stringify(o.case_id)} supplied for case ${JSON.stringify(c.id)}`); return finish(e); }
  const malformed = new Set<string>();
  for (const i of issues) { const [, list, index] = ITEM.exec(i.path)!; const path = `/${list}/${index}`; if (!malformed.has(path)) { malformed.add(path); error('malformed_item', path, i.message); } }

  // Pinned runtime adapter: the reported items must be exactly what the probe log and the call records show.
  const unsupported = new Set<string>();
  let seqTrusted = true;
  let gaps: EvidenceGap[] = [];
  if (probeMode) ({ seqTrusted, gaps } = checkRuntimeReport(c, o as unknown as RuntimeObservation, malformed, unsupported, control, e, error));

  // Decisions: one per step; duplicates and out-of-range steps are not guessed between.
  const decisions = new Map<number, Decision[]>();
  o.decisions.forEach((value, index) => {
    if (malformed.has(`/decisions/${index}`) || unsupported.has(`/decisions/${index}`)) return;
    const d = value as Decision;
    if (d.step >= c.steps.length) { error('decision_out_of_range', `/decisions/${index}`, `decision step ${d.step} is outside the case schedule`); return; }
    if (control.has(d.step)) { error('decision_at_control_step', `/decisions/${index}`, `step ${d.step} (${c.steps[d.step].op}) is a harness control step; the SUT makes no decision there`); return; }
    decisions.set(d.step, [...(decisions.get(d.step) ?? []), d]);
  });
  for (const [step, list] of decisions) if (list.length > 1) error('duplicate_decision', '/decisions', `${list.length} decisions recorded for step ${step}; none is used`);

  // Effects: attribution to the corpus identity, without guessing unknown bindings.
  const attributable: { f: Effect; path: string }[] = [];
  o.effects.forEach((value, index) => {
    const path = `/effects/${index}`;
    if (malformed.has(path) || unsupported.has(path)) return;
    const f = value as Effect;
    const item = canonicalJson(f);
    if (f.step >= c.steps.length) return error('effect_out_of_range', path, `effect ${item} is outside the case schedule`);
    if (f.kind === 'revocation_ack') {
      const s = c.steps[f.step];
      if (f.authority !== null || f.execution !== null || f.target === null) return error('unattributable_effect', path, `revocation acknowledgement ${item} must name only its target`);
      if (s.op !== 'revoke') return error('unattributable_effect', path, `revocation acknowledgement ${item} does not occur at a revocation operation`);
    } else {
      if (f.target !== null) return error('unattributable_effect', path, `only revocation acknowledgements carry a target: ${item}`);
      if (!c.authorities.some(a => a.id === f.authority)) return error('unattributable_effect', path, `unknown authority in ${item}`);
      if (EXECUTION_KINDS.has(f.kind)) {
        if (!c.steps.some(s => 'execution' in s && s.execution === f.execution && s.authority === f.authority)) return error('unattributable_effect', path, `execution ${JSON.stringify(f.execution)} is not bound to authority ${JSON.stringify(f.authority)} anywhere in the case; attribution is not guessed and the original item is kept in the observations: ${item}`);
      } else if (f.execution !== null) return error('unattributable_effect', path, `unexpected execution binding in ${item}`);
    }
    attributable.push({ f, path });
  });

  // Causal consistency: an execution effect needs an earlier start, a delivery an earlier commit, one terminal per execution.
  // Occurrence step orders the trace; the arrival order of records never does. With a probe-bound seq (0.4.0 runtime
  // observations) effects of one step are ordered by seq; equal (step, seq) establishes no order. That blocks only the
  // order inference concerned (recorded as incompleteness); the effect still takes part in the step-based evaluation.
  const seqOf = (f: Effect) => (f as Effect & { seq?: number }).seq ?? 0;
  const before = (a: Effect, b: Effect) => a.step < b.step || (probeMode && seqTrusted && a.step === b.step && seqOf(a) < seqOf(b));
  const unordered = (a: Effect, b: Effect) => probeMode && a.step === b.step && (!seqTrusted || seqOf(a) === seqOf(b));
  const orderUnknown = (f: Effect, what: string) => e.incomplete.push(`effect order not established at step ${f.step}: ${f.kind} of ${f.execution} relative to ${what}`);
  const byStep = attributable.map(x => ({ ...x, key: canonicalJson(x.f) })).sort((x, y) => x.f.step - y.f.step || (probeMode ? seqOf(x.f) - seqOf(y.f) : 0) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const starts = (key: string) => byStep.filter(x => x.f.kind === 'execution_started' && executionKey(x.f) === key).map(x => x.f);
  const rejected = new Set<string>();
  for (const x of byStep) {
    if (!NEEDS_START.has(x.f.kind)) continue;
    const s = starts(executionKey(x.f));
    if (s.some(y => before(y, x.f))) continue;
    if (s.some(y => unordered(y, x.f))) { orderUnknown(x.f, 'its start'); continue; }
    rejected.add(x.path); error('causally_impossible', x.path, `${x.f.kind} at step ${x.f.step} precedes every observed start of ${x.f.execution}`);
  }
  for (const x of byStep) {
    if (x.f.kind !== 'output_delivery' || rejected.has(x.path)) continue;
    const commits = byStep.filter(y => y.f.kind === 'tool_commit' && !rejected.has(y.path) && executionKey(y.f) === executionKey(x.f)).map(y => y.f);
    if (commits.some(y => before(y, x.f))) continue;
    if (commits.some(y => unordered(y, x.f))) { orderUnknown(x.f, 'its commit'); continue; }
    // A commit of this execution whose state evidence is contradictory up to the delivery is unconfirmed, not absent:
    // the delivery is not impossible.
    if (gaps.some(g => gapCovers(g, 'tool_commit', x.f.execution, 0, x.f.step))) { e.incomplete.push(`output_delivery at step ${x.f.step} of ${x.f.execution}: its commit's state evidence is contradictory`); continue; }
    rejected.add(x.path); error('causally_impossible', x.path, `output_delivery at step ${x.f.step} precedes every observed commit of ${x.f.execution}`);
  }
  const terminals = new Map<string, string[]>();
  for (const x of byStep) if (x.f.kind === 'execution_terminal' && !rejected.has(x.path)) terminals.set(executionKey(x.f), [...(terminals.get(executionKey(x.f)) ?? []), x.path]);
  for (const [key, paths] of terminals) if (paths.length > 1) for (const path of paths) { rejected.add(path); error('causally_impossible', path, `execution ${key} reported terminal ${paths.length} times`); }
  const accepted = byStep.filter(x => !rejected.has(x.path)).map(x => x.f);
  const effectsExcluded = attributable.length !== o.effects.length || rejected.size > 0;

  // Policy decisions, compared separately from effects.
  if (!o.complete) e.incomplete.push('observation window not sealed');
  for (const d of truth.decisions) {
    if (control.has(d.step)) continue;
    const list = decisions.get(d.step);
    if (!list || list.length !== 1) e.incomplete.push(`decision unavailable at step ${d.step}`);
    else if (list[0].decision === 'UNKNOWN') e.incomplete.push(`authority unknown at step ${d.step}`);
    else if (list[0].decision !== d.decision) e.decision_findings.push({ step: d.step, reason: d.decision === 'DENY' ? 'false_allow' : 'false_deny' });
  }

  // Observed effects at their occurrence step against expected windows; multisets keep duplicates.
  const open = truth.effects.map(x => ({ x, used: false }));
  const matched: Effect[] = [];
  for (const f of accepted) {
    const match = open.filter(m => !m.used && sameIdentity(f, m.x) && withinWindow(f.step, m.x)).sort((p, q) => p.x.latest - q.x.latest)[0];
    if (match === undefined) e.effect_findings.push({ step: f.step, reason: `unexpected_${f.kind}` });
    else { match.used = true; matched.push(f); }
  }
  // A side effect after its execution's observed terminal is a violation even where its step matches the corpus.
  for (const f of matched) {
    if (f.kind !== 'tool_commit' && f.kind !== 'output_delivery') continue;
    const terminals = accepted.filter(t => t.kind === 'execution_terminal' && executionKey(t) === executionKey(f));
    if (terminals.some(t => before(t, f))) e.effect_findings.push({ step: f.step, reason: `${f.kind}_after_terminal` });
    else if (terminals.some(t => unordered(t, f))) orderUnknown(f, 'its terminal');
  }
  for (const { x } of open.filter(m => !m.used)) {
    const at = x.kind === 'execution_terminal' ? `${x.execution} in window ${x.earliest}..${x.latest}` : `${x.kind} at step ${x.earliest}`;
    // Contradictory state evidence (probe_seq mode) leaves the expected effect it concerns unconfirmed, never missing;
    // it does not touch the expected effects of other kinds, executions or windows.
    const gap = gaps.some(g => gapCovers(g, x.kind, x.execution, x.earliest, x.latest));
    if (!o.complete || effectsExcluded || gap) e.incomplete.push(`expected effect not confirmed: ${at}`);
    else if (x.kind === 'execution_terminal') e.incomplete.push(`terminal evidence missing for ${at}`);
    else e.effect_findings.push({ step: x.earliest, reason: `missing_${x.kind}` });
  }
  // Any observed start, including an unauthorized one, needs a later terminal observation.
  const acceptedStarts = accepted.filter(f => f.kind === 'execution_started');
  for (const started of acceptedStarts) {
    const terminals = accepted.filter(f => f.kind === 'execution_terminal' && executionKey(f) === executionKey(started));
    if (terminals.some(t => before(started, t))) continue;
    if (terminals.some(t => unordered(started, t))) orderUnknown(started, 'its terminal');
    else e.incomplete.push(`execution not observed terminal: ${started.execution}`);
  }
  return finish(e);
}

type ErrorSink = (code: string, path: string, message: string) => void;

/**
 * Checks a pinned runtime adapter observation against its own raw evidence (section 4.6):
 *  - the probe log is well formed (otherwise no order within a step is trusted);
 *  - every reported effect is exactly a fact's first presence in the probe log (step, seq, identity, provenance);
 *  - every fact first present outside a step barrier is drift (incomplete), never an effect;
 *  - every reported decision is the SUT answer recorded in the call of its step.
 * Reported items without that evidence are excluded and reported as errors; evidence the report omits is an error.
 *  - every fact whose state evidence is contradictory (a terminal without its record and terminal-log entry, a commit
 *    key without its written value or version growth) is incomplete evidence, never an effect.
 * Returns whether seq can be trusted for ordering within a step, and the scope of each contradictory fact.
 */
function checkRuntimeReport(c: Case, o: RuntimeObservation, malformed: Set<string>, unsupported: Set<string>, control: Set<number>, e: Evidence, error: ErrorSink): { seqTrusted: boolean; gaps: EvidenceGap[] } {
  const logIssues = probeLogIssues(o.probes);
  for (const issue of logIssues) error('sequence_inconsistent', '/probes', issue);
  const derived = derive(o.probes, o.identity);
  for (const r of derived.regressions) error('sequence_inconsistent', '/probes', r);
  for (const d of derived.drift) e.incomplete.push(`effect observed outside a step barrier (probe ${d.probe}, ${d.point}): ${d.key}`);
  for (const x of derived.inconsistent) e.incomplete.push(`inconsistent state evidence (probe ${x.probe}): ${x.key}: ${x.reason}`);
  const open = derived.effects.map(x => ({ slot: effectSlot(x.effect), kind: x.effect.kind, step: x.effect.step, key: x.key, used: false }));
  o.effects.forEach((f, index) => {
    const path = `/effects/${index}`;
    if (malformed.has(path)) return;
    const slot = effectSlot(f);
    const match = open.find(m => !m.used && m.slot === slot);
    if (!match) {
      unsupported.add(path);
      const sameStep = open.some(m => !m.used && m.kind === f.kind && m.step === f.step);
      return error(sameStep ? 'sequence_inconsistent' : 'effect_without_probe_evidence', path, `reported effect ${slot} is not the first presence of any fact in the probe log`);
    }
    match.used = true;
    if (canonicalJson([...f.provenance].sort()) !== canonicalJson([...EFFECT_PROVENANCE[f.kind]].sort())) error('provenance_mismatch', path, `${f.kind} must carry provenance ${EFFECT_PROVENANCE[f.kind].join('+')}`);
  });
  for (const m of open.filter(x => !x.used)) error('effect_not_reported', '/effects', `probe log shows ${m.key} first at ${m.slot}, but the observation does not report it`);
  const calls = new Map<number, number>();
  o.calls.forEach(call => calls.set(call.step, (calls.get(call.step) ?? 0) + 1));
  for (const [step, n] of calls) if (n > 1) error('duplicate_call', '/calls', `${n} SUT calls recorded for step ${step}`);
  const reported = new Set<number>();
  o.decisions.forEach((d, index) => {
    const path = `/decisions/${index}`;
    if (malformed.has(path) || d.step >= c.steps.length || control.has(d.step)) return;
    reported.add(d.step);
    const derivedDecision = decisionFromCall(c.steps[d.step], o.calls.find(call => call.step === d.step));
    if (derivedDecision !== d.decision) { unsupported.add(path); return error('decision_without_evidence', path, `decision ${d.decision} at step ${d.step} is not the SUT answer recorded for that step (${derivedDecision ?? 'no call'})`); }
    if (canonicalJson([...d.provenance].sort()) !== canonicalJson([...DECISION_PROVENANCE].sort())) error('provenance_mismatch', path, 'decisions carry sut_api provenance');
  });
  for (const call of o.calls) {
    if (call.step < c.steps.length && !control.has(call.step) && !reported.has(call.step) && decisionFromCall(c.steps[call.step], call) !== undefined) error('decision_not_reported', '/decisions', `the SUT call of step ${call.step} is recorded, but its decision is not reported`);
  }
  // A contradictory fact can have occurred between the probe before its first contradictory probe and that probe.
  const gaps = derived.inconsistent.map(x => ({ kind: x.kind, execution: x.execution, from: o.probes[x.probe - 1]?.step ?? o.probes[x.probe].step, to: o.probes[x.probe].step }));
  return { seqTrusted: logIssues.length === 0 && derived.regressions.length === 0, gaps };
}

function finish(e: Evidence): Evidence {
  e.incomplete = [...new Set(e.incomplete)];
  e.confirmed_violation = e.decision_findings.length > 0 || e.effect_findings.length > 0;
  e.verdict = e.errors.length ? 'HARNESS_ERROR' : e.confirmed_violation ? 'VIOLATION' : e.incomplete.length ? 'UNASSESSABLE' : 'PASS';
  return e;
}
