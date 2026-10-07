import { canonicalJson } from '../../util/canonical-json';
import { Case, Evidence, Expected, Observation } from '../../spec/revocation/model';
import { validateObservation } from '../../report/revocation/validate';
/** Expected truth is passed in after precomputation, never derived from observations. */
export function evaluate(c: Case, truth: Expected, input: unknown): Evidence {
  const e: Evidence = { case_id: c.id, stage: c.stage, verdict: 'PASS', decision_findings: [], effect_findings: [], incomplete: [], errors: [] };
  const schemaErrors = validateObservation(input);
  if (schemaErrors.length) { e.errors.push(...schemaErrors); e.verdict = 'HARNESS_ERROR'; return e; }
  const o = input as Observation;
  if (o.case_id !== c.id) e.errors.push('case identity mismatch');
  const decisions = new Set<number>();
  for (const d of o.decisions) {
    if (d.step >= c.steps.length || decisions.has(d.step)) e.errors.push('duplicate or out-of-range decision');
    decisions.add(d.step);
  }
  for (const f of o.effects) {
    if (f.step >= c.steps.length) { e.errors.push('out-of-range effect'); continue; }
    if (f.kind === 'revocation_ack') {
      if (f.authority !== null || f.execution !== null || c.steps[f.step].op !== 'revoke') e.errors.push('invalid revocation acknowledgement identity');
    } else {
      if (!c.authorities.some(a => a.id === f.authority)) e.errors.push('unknown effect authority');
      const withExecution = !['approval_granted', 'permit_issued'].includes(f.kind);
      if (withExecution && !c.steps.some(s => 'execution' in s && s.execution === f.execution && s.authority === f.authority)) e.errors.push('unknown effect execution binding');
      if (!withExecution && f.execution !== null) e.errors.push('unexpected execution binding');
    }
  }
  if (e.errors.length) { e.verdict = 'HARNESS_ERROR'; return e; }
  if (!o.complete) e.incomplete.push('observation window not sealed');
  for (const d of truth.decisions) {
    const actual = o.decisions.find(a => a.step === d.step);
    if (!actual || actual.decision === 'UNKNOWN') e.incomplete.push(`authority unavailable at step ${d.step}`);
    else if (actual.decision !== d.decision) e.decision_findings.push({ step: d.step, reason: d.decision === 'DENY' ? 'false_allow' : 'false_deny' });
  }
  // Multisets preserve duplicate effects. Events use occurrence step, allowing late effects.
  const remaining = truth.effects.map(f => canonicalJson(f));
  for (const f of o.effects) {
    const index = remaining.indexOf(canonicalJson(f));
    if (index < 0) e.effect_findings.push({ step: f.step, reason: `unexpected_${f.kind}` });
    else remaining.splice(index, 1);
  }
  if (o.complete) for (const f of remaining) { const parsed = JSON.parse(f); if (parsed.kind === 'execution_terminal') e.incomplete.push(`terminal evidence missing for ${parsed.execution}`); else e.effect_findings.push({ step: parsed.step, reason: `missing_${parsed.kind}` }); }
  // Any observed start, including an unauthorized one, needs a later terminal event.
  for (const started of o.effects.filter(f => f.kind === 'execution_started')) {
    if (!o.effects.some(f => f.kind === 'execution_terminal' && f.authority === started.authority && f.execution === started.execution && f.step > started.step)) e.incomplete.push(`execution not observed terminal: ${started.execution}`);
  }
  e.incomplete = [...new Set(e.incomplete)];
  e.verdict = e.decision_findings.length || e.effect_findings.length ? 'VIOLATION' : e.incomplete.length ? 'UNASSESSABLE' : 'PASS';
  return e;
}
