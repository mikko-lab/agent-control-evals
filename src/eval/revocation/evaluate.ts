import { canonicalJson } from '../../util/canonical-json';
import { Case, Decision, Effect, Evidence, Expected, ExpectedEffect } from '../../spec/revocation/model';
import { observationIssues } from '../../report/revocation/validate';

const EXECUTION_KINDS = new Set(['execution_started', 'tool_commit', 'output_delivery', 'cancellation_ack', 'execution_terminal']);
const NEEDS_START = new Set(['tool_commit', 'output_delivery', 'cancellation_ack', 'execution_terminal']);
const ITEM = /^\/(decisions|effects)\/(\d+)(\/|$)/;

/** Occurrence step admissible for an expected effect: exact step, or the terminal window from finish request to seal. */
export function withinWindow(step: number, expected: ExpectedEffect): boolean {
  return step >= expected.earliest && step <= expected.latest;
}

const sameIdentity = (f: Effect, x: ExpectedEffect) => f.kind === x.kind && f.authority === x.authority && f.execution === x.execution && canonicalJson(f.target) === canonicalJson(x.target);
const executionKey = (f: Effect) => `${f.authority}/${f.execution}`;

/**
 * Expected truth is passed in after precomputation, never derived from observations.
 * Malformed or unattributable items and causally impossible traces are HARNESS_ERRORs, but every remaining
 * well-formed attributable item is still evaluated and its findings are retained beside the errors.
 */
export function evaluate(c: Case, truth: Expected, input: unknown): Evidence {
  const e: Evidence = { case_id: c.id, family: c.family, state_at_cut: truth.cuts, verdict: 'PASS', confirmed_violation: false, decision_findings: [], effect_findings: [], incomplete: [], errors: [] };
  const error = (code: string, path: string, message: string) => e.errors.push({ code, path, message });
  const issues = observationIssues(input);
  const fatal = issues.filter(i => !ITEM.test(i.path));
  if (fatal.length) { for (const i of fatal) error('malformed_observation', i.path || '/', i.message); return finish(e); }
  const o = input as { case_id: string; complete: boolean; decisions: unknown[]; effects: unknown[] };
  if (o.case_id !== c.id) { error('case_identity_mismatch', '/case_id', `observation for ${JSON.stringify(o.case_id)} supplied for case ${JSON.stringify(c.id)}`); return finish(e); }
  const malformed = new Set<string>();
  for (const i of issues) { const [, list, index] = ITEM.exec(i.path)!; const path = `/${list}/${index}`; if (!malformed.has(path)) { malformed.add(path); error('malformed_item', path, i.message); } }

  // Decisions: one per step; duplicates and out-of-range steps are not guessed between.
  const decisions = new Map<number, Decision[]>();
  o.decisions.forEach((value, index) => {
    if (malformed.has(`/decisions/${index}`)) return;
    const d = value as Decision;
    if (d.step >= c.steps.length) { error('decision_out_of_range', `/decisions/${index}`, `decision step ${d.step} is outside the case schedule`); return; }
    decisions.set(d.step, [...(decisions.get(d.step) ?? []), d]);
  });
  for (const [step, list] of decisions) if (list.length > 1) error('duplicate_decision', '/decisions', `${list.length} decisions recorded for step ${step}; none is used`);

  // Effects: attribution to the corpus identity, without guessing unknown bindings.
  const attributable: { f: Effect; path: string }[] = [];
  o.effects.forEach((value, index) => {
    const path = `/effects/${index}`;
    if (malformed.has(path)) return;
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
  // Occurrence step orders the trace; the arrival order of records never does.
  const byStep = attributable.map(x => ({ ...x, key: canonicalJson(x.f) })).sort((x, y) => x.f.step - y.f.step || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const startSteps = (key: string) => byStep.filter(x => x.f.kind === 'execution_started' && executionKey(x.f) === key).map(x => x.f.step);
  const rejected = new Set<string>();
  for (const x of byStep) {
    if (NEEDS_START.has(x.f.kind) && !startSteps(executionKey(x.f)).some(step => step < x.f.step)) { rejected.add(x.path); error('causally_impossible', x.path, `${x.f.kind} at step ${x.f.step} precedes every observed start of ${x.f.execution}`); }
  }
  for (const x of byStep) {
    if (x.f.kind !== 'output_delivery' || rejected.has(x.path)) continue;
    if (!byStep.some(y => y.f.kind === 'tool_commit' && !rejected.has(y.path) && executionKey(y.f) === executionKey(x.f) && y.f.step < x.f.step)) { rejected.add(x.path); error('causally_impossible', x.path, `output_delivery at step ${x.f.step} precedes every observed commit of ${x.f.execution}`); }
  }
  const terminals = new Map<string, string[]>();
  for (const x of byStep) if (x.f.kind === 'execution_terminal' && !rejected.has(x.path)) terminals.set(executionKey(x.f), [...(terminals.get(executionKey(x.f)) ?? []), x.path]);
  for (const [key, paths] of terminals) if (paths.length > 1) for (const path of paths) { rejected.add(path); error('causally_impossible', path, `execution ${key} reported terminal ${paths.length} times`); }
  const accepted = byStep.filter(x => !rejected.has(x.path)).map(x => x.f);
  const effectsExcluded = attributable.length !== o.effects.length || rejected.size > 0;

  // Policy decisions, compared separately from effects.
  if (!o.complete) e.incomplete.push('observation window not sealed');
  for (const d of truth.decisions) {
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
    if ((f.kind === 'tool_commit' || f.kind === 'output_delivery') && accepted.some(t => t.kind === 'execution_terminal' && executionKey(t) === executionKey(f) && t.step < f.step)) e.effect_findings.push({ step: f.step, reason: `${f.kind}_after_terminal` });
  }
  for (const { x } of open.filter(m => !m.used)) {
    const at = x.kind === 'execution_terminal' ? `${x.execution} in window ${x.earliest}..${x.latest}` : `${x.kind} at step ${x.earliest}`;
    if (!o.complete || effectsExcluded) e.incomplete.push(`expected effect not confirmed: ${at}`);
    else if (x.kind === 'execution_terminal') e.incomplete.push(`terminal evidence missing for ${at}`);
    else e.effect_findings.push({ step: x.earliest, reason: `missing_${x.kind}` });
  }
  // Any observed start, including an unauthorized one, needs a later terminal observation.
  const acceptedStarts = accepted.filter(f => f.kind === 'execution_started');
  for (const started of acceptedStarts) {
    if (!accepted.some(f => f.kind === 'execution_terminal' && executionKey(f) === executionKey(started) && f.step > started.step)) e.incomplete.push(`execution not observed terminal: ${started.execution}`);
  }
  return finish(e);
}

function finish(e: Evidence): Evidence {
  e.incomplete = [...new Set(e.incomplete)];
  e.confirmed_violation = e.decision_findings.length > 0 || e.effect_findings.length > 0;
  e.verdict = e.errors.length ? 'HARNESS_ERROR' : e.confirmed_violation ? 'VIOLATION' : e.incomplete.length ? 'UNASSESSABLE' : 'PASS';
  return e;
}
