import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCorpus } from '../../src/corpus/revocation/cases';
import { DESIGN } from '../../src/corpus/revocation/design';
import { covers, expected } from '../../src/oracle/revocation/expected';
import { observe } from '../../src/adapter/revocation-reference/runtime';
import { evaluate } from '../../src/eval/revocation/evaluate';
import { FAMILIES, Step } from '../../src/spec/revocation/model';
import { canonicalJsonLines } from '../../src/util/canonical-json';
import { sha256Hex } from '../../src/util/hash';
import { checkOracleBoundary } from '../../src/oracle/boundary-check';
import { cases, get, root } from './helpers';

const firstCut = (steps: Step[]) => steps.findIndex(s => s.op === 'revoke');

test('golden corpus bytes, hash, unique variants and deterministic regeneration', () => {
  const corpus = canonicalJsonLines(cases);
  assert.equal(corpus, canonicalJsonLines(generateCorpus()));
  assert.equal(corpus, readFileSync(join(root, 'corpus/revocation/smoke.jsonl'), 'utf8'));
  assert.equal(sha256Hex(corpus), readFileSync(join(root, 'corpus/revocation/smoke.sha256'), 'utf8').trim());
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
  assert.deepEqual(new Set(cases.map(c => c.family)), new Set(FAMILIES));
});

test('corpus structure: fresh state, final seal, consistent authority tree, explicit finish for every possible start', () => {
  for (const c of cases) {
    assert.equal(c.steps.at(-1)!.op, 'seal', c.id);
    assert.equal(c.steps.filter(s => s.op === 'seal').length, 1, c.id);
    const ids = new Set(c.authorities.map(a => a.id)); assert.equal(ids.size, c.authorities.length);
    for (const a of c.authorities) {
      const visited = new Set<string>(); let current = a;
      while (current.parent !== null) {
        assert(!visited.has(current.id), 'cycle'); visited.add(current.id);
        const parent = c.authorities.find(x => x.id === current.parent)!;
        assert(parent, 'missing parent'); assert.equal(parent.tenant, current.tenant); assert.equal(parent.session, current.session); current = parent;
      }
    }
    c.steps.forEach((s, i) => {
      if (s.op === 'start') assert(c.steps.slice(i + 1).some(f => f.op === 'finish' && f.authority === s.authority && f.execution === s.execution), `${c.id}: start@${i} has no later finish`);
    });
  }
});

test('runtime input carries no expectations, design claims or derived state', () => {
  for (const c of cases) {
    assert.deepEqual(Object.keys(c).sort(), ['authorities', 'family', 'id', 'steps']);
    for (const a of c.authorities) assert.deepEqual(Object.keys(a).sort(), ['id', 'initial', 'parent', 'session', 'tenant']);
  }
});

test('oracle closure is statically independent of runtimes, evaluator and filesystem; runtime imports no oracle or corpus', () => {
  const result = checkOracleBoundary(root); assert.deepEqual(result.violations, []);
  for (const f of ['src/oracle/revocation/expected.ts', 'src/corpus/revocation/cases.ts', 'src/corpus/revocation/design.ts']) assert(result.closure.includes(f), f);
  const runtime = readFileSync(join(root, 'src/adapter/revocation-reference/runtime.ts'), 'utf8');
  assert(!/from\s+['"][^'"]*(oracle|eval|corpus|report)/.test(runtime));
});

test('every designed baseline variant passes with separately observed decisions and effects', () => {
  for (const c of cases) assert.equal(evaluate(c, expected(c), observe(c)).verdict, 'PASS', c.id);
});

test('design claims match the oracle replay exactly (no overdetermined sole-revocation claim)', () => {
  assert.deepEqual(Object.keys(DESIGN).sort(), cases.map(c => c.id).sort());
  for (const c of cases) {
    const d = DESIGN[c.id], t = expected(c), cut = firstCut(c.steps);
    for (const q of d.required_denials) assert.deepEqual(t.rationale.find(r => r.step === q.step)?.reasons, q.reasons, `${c.id}@${q.step}`);
    for (const s of d.allowed_after_cut) { assert(cut >= 0 && s > cut, `${c.id}@${s} after cut`); assert.equal(t.decisions[s].decision, 'ALLOW', `${c.id}@${s}`); }
    for (const s of d.retained_before_cut) {
      assert(cut < 0 || s < cut, `${c.id}@${s} before cut`); assert.equal(t.decisions[s].decision, 'ALLOW', `${c.id}@${s}`);
      assert(t.effects.some(x => x.earliest === s), `${c.id}@${s} retained effect`);
    }
  }
});

test('coverage: every fence is tested where revocation alone explains the denial, for every required scope', () => {
  const covered = new Set<string>();
  for (const c of cases) {
    const t = expected(c);
    for (const q of DESIGN[c.id].required_denials) {
      if (q.reasons.join() !== 'revoked') continue;
      const s = c.steps[q.step] as Exclude<Step, { op: 'revoke' } | { op: 'seal' }>;
      const cut = t.cuts.find(k => k.step < q.step && covers(c.authorities, s.authority, k.target))!;
      const scope = cut.target.scope === 'authority' ? (cut.target.id === s.authority ? 'authority' : 'descendant') : cut.target.scope;
      covered.add(`${s.op}:${scope}`);
    }
  }
  const required = ['approve:authority', 'approve:descendant', 'issue:authority', 'start:authority', 'start:descendant', 'start:session', 'start:tenant', 'commit:authority', 'commit:descendant', 'commit:session', 'commit:tenant', 'deliver:authority', 'deliver:session'];
  for (const r of required) assert(covered.has(r), `missing sole-revocation coverage for ${r}`);
});

test('coverage: in-flight session, tenant and descendant fences act on executions that are running or committed at the cut', () => {
  const at = (id: string) => expected(get(id)).cuts[0];
  const phase = (id: string, authority: string) => at(id).authorities.find(a => a.id === authority)!;
  assert.deepEqual(phase('session-in-flight-commit-fence', 'a'), { id: 'a', grant: 'consumed', revoked: 'by_cut', executions: [{ id: 'e1', phase: 'running' }] });
  assert.deepEqual(phase('session-in-flight-commit-fence', 'o'), { id: 'o', grant: 'consumed', revoked: 'no', executions: [{ id: 'e2', phase: 'running' }] });
  assert.deepEqual(phase('session-delivery-fence-after-commit', 'a').executions, [{ id: 'e1', phase: 'committed' }]);
  const tenant = at('tenant-multi-session-in-flight');
  assert.deepEqual(tenant.authorities.map(a => [a.id, a.revoked, a.executions[0].phase]), [['a', 'by_cut', 'running'], ['b', 'by_cut', 'running'], ['c', 'no', 'running']]);
  assert.notEqual(get('tenant-multi-session-in-flight').authorities[0].session, get('tenant-multi-session-in-flight').authorities[1].session);
  assert.deepEqual(phase('derived-in-flight-ancestor-revoked', 'child'), { id: 'child', grant: 'consumed', revoked: 'by_cut', executions: [{ id: 'e2', phase: 'running' }] });
  assert.deepEqual(phase('in-flight-after-commit', 'a').executions, [{ id: 'e1', phase: 'committed' }]);
  // Delivery fences are tested only where a commit already exists, so a missing commit cannot explain the denial.
  for (const c of cases) for (const q of DESIGN[c.id].required_denials) if (c.steps[q.step].op === 'deliver' && q.reasons.join() === 'revoked') assert(expected(c).effects.some(x => x.kind === 'tool_commit' && x.earliest < q.step), c.id);
});

test('state at cut is replayed, not taken from the family label; multi-authority cases keep per-authority states', () => {
  const sibling = expected(get('sibling-isolation')).cuts[0];
  assert.deepEqual(sibling.authorities.map(a => [a.id, a.grant, a.revoked]), [['a', 'issued', 'no'], ['child', 'issued', 'by_cut'], ['sibling', 'issued', 'no']]);
  const duplicate = expected(get('duplicate-revocation')).cuts;
  assert.deepEqual(duplicate.map(k => k.authorities[0].revoked), ['by_cut', 'before_cut']);
  // A family names the design intent; the replay shows e.g. that start-before-cut has a running execution at the cut.
  assert.equal(get('start-before-cut').family, 'in_flight_before_commit');
  assert.deepEqual(expected(get('start-before-cut')).cuts[0].authorities[0].executions, [{ id: 'e1', phase: 'running' }]);
  assert.deepEqual(expected(get('approval-before-cut')).cuts[0].authorities[0].executions, [{ id: 'e1', phase: 'finish_requested' }]);
});

test('race orderings: both linearizations of start and cut are present and differ only in the order', () => {
  const before = expected(get('cut-before-start')), after = expected(get('start-before-cut'));
  assert.equal(before.decisions[1].decision, 'DENY'); assert.deepEqual(before.rationale[0], { step: 1, reasons: ['revoked'] });
  assert.equal(after.decisions[0].decision, 'ALLOW'); assert.deepEqual(after.rationale, [{ step: 2, reasons: ['revoked'] }]);
  const commitFirst = expected(get('commit-before-cut')), cutFirst = expected(get('in-flight-before-commit'));
  assert(commitFirst.effects.some(x => x.kind === 'tool_commit')); assert(!cutFirst.effects.some(x => x.kind === 'tool_commit'));
});

test('oracle: earlier irreversible commits are retained, later delivery forbidden, finish allowed after the cut', () => {
  const after = expected(get('in-flight-after-commit'));
  assert.deepEqual(after.effects.filter(x => x.kind === 'tool_commit').map(x => x.earliest), [1]);
  assert(!after.effects.some(x => x.kind === 'output_delivery'));
  assert.deepEqual(after.effects.find(x => x.kind === 'execution_terminal'), { kind: 'execution_terminal', authority: 'a', execution: 'e1', target: null, earliest: 6, latest: 7 });
  assert.deepEqual(expected(get('pending-approval')).effects.map(x => x.kind), ['revocation_ack']);
  assert.deepEqual(expected(get('execution-id-reuse')).rationale.map(r => r.reasons), [['execution_id_in_use'], ['unbound_execution'], ['unbound_execution']]);
});
