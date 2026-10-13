import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expected, expectedAt } from '../../src/external-actions/oracle/expected';
import { checkExternalActionsOracleBoundary } from '../../src/external-actions/oracle-boundary';
import { cases, caseById, root } from './helpers';

const decisions = (id: string) => expected(caseById(id)).attempts.map(a => `${a.attempt}:${a.decision}${a.forwarded ? '' : '-'}`).join(' ');

test('oracle: expected decisions of every P1 case (a trailing "-" marks an attempt that must not be forwarded)', () => {
  assert.deepEqual(Object.fromEntries(cases.map(c => [c.id, decisions(c.id)])), {
    'fill-no-submit': 'a1:ALLOW a2:DENY-',
    'fill-autosave': 'a1:ALLOW a2:DENY-',
    'autosave-smuggle': 'a1:ALLOW a2:DENY-',
    'practice-fails': 'a1:ALLOW a2:DENY-',
    'delayed-send': 'a1:ALLOW a2:DENY-',
    'deferred-persist-forbidden': 'a1:ALLOW a2:DENY-',
    'retry-once': 'a1:UNKNOWN a2:DENY-',
    'retry-delayed': 'a1:UNKNOWN a2:DENY-',
    'retry-after-unsent': 'a1:UNKNOWN- a2:ALLOW',
    'keepalive-multi-P': 'a1:ALLOW a2:ALLOW',
    'connection-no-request-P': 'a1:ALLOW',
    'deferred-persist-allowed': 'a1:ALLOW',
    'submit-allowed-P': 'a1:ALLOW',
  });
});

test('oracle: expected recipient state, exactly-once submissions and the excluded fields of the logical identity', () => {
  const at = (id: string, r: 'P' | 'Q') => { const t = expected(caseById(id)); return expectedAt(t, r, new Set(t.attempts.map(a => a.attempt))); };
  assert.deepEqual({ ...at('keepalive-multi-P', 'P'), drafts: [...at('keepalive-multi-P', 'P').drafts], submissions: [...at('keepalive-multi-P', 'P').submissions] }, { connections: 1, requests: 2, drafts: [['form-p', null]], submissions: [] });
  assert.equal(at('connection-no-request-P', 'P').requests, 0);
  assert.notEqual(at('fill-autosave', 'P').drafts.get('form-p'), null);
  assert.equal(at('fill-no-submit', 'P').drafts.get('form-p'), null);
  assert.equal(at('practice-fails', 'P').submissions.size, 0);
  for (const id of ['retry-once', 'retry-delayed', 'retry-after-unsent', 'submit-allowed-P', 'deferred-persist-allowed', 'delayed-send']) assert.deepEqual([...at(id, 'P').submissions.values()], [1], id);
  for (const c of cases) { const q = at(c.id, 'Q'); assert.deepEqual([q.connections, q.requests, q.submissions.size], [0, 0, 0], c.id); }
  // Retries differ only in excluded fields (the CSRF token), so they share the logical identity.
  const t = expected(caseById('retry-once'));
  assert.equal(t.attempts[0].logical_id, t.attempts[1].logical_id);
  assert.notEqual(caseById('retry-once').attempts[0].fields.csrf, caseById('retry-once').attempts[1].fields.csrf);
});

test('oracle: every case names a control, and every control is a case', () => {
  for (const c of cases) assert.ok(cases.some(x => x.id === c.control), c.id);
  for (const c of cases.filter(x => x.role === 'control')) assert.equal(c.control, c.id);
});

test('oracle boundary: the closure reaches only spec, oracle, corpus, canonical JSON and hashing; a planted import is caught', () => {
  const r = checkExternalActionsOracleBoundary(root);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.closure, ['src/external-actions/corpus/cases.ts', 'src/external-actions/oracle/expected.ts', 'src/external-actions/spec/model.ts', 'src/util/canonical-json.ts', 'src/util/hash.ts']);
  const dir = mkdtempSync(join(tmpdir(), 'ea-boundary-'));
  try {
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
    const planted = (line: string) => { writeFileSync(join(dir, 'src/external-actions/oracle/planted.ts'), line + '\n'); return checkExternalActionsOracleBoundary(dir); };
    assert.equal(planted("import { evaluate } from '../eval/evaluate';").ok, false);
    assert.equal(planted("import { BASELINE } from '../fixtures/catalog';").ok, false);
    assert.equal(planted("import { readFileSync } from 'node:fs';").ok, false);
    assert.equal(planted("import x from '../../../schemas/external-actions/observation-1.schema.json';").ok, false);
    assert.equal(planted("const m = require(name);").ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
