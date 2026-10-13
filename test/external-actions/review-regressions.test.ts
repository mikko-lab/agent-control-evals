/**
 * Review regressions for P1a: per-attempt effect evaluation, the full draft history, and the content binding and
 * persistence of submission records. Each is checked in process and through the recorded-CLI path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson } from '../../src/util/canonical-json';
import { singleCaseExit } from '../../src/external-actions/eval/evaluate';
import { evaluateRun } from '../../src/external-actions/eval/run';
import { fixtureById } from '../../src/external-actions/fixtures/catalog';
import { loadProfile, subProfile } from '../../src/external-actions/self-test';
import { Evidence } from '../../src/external-actions/spec/model';
import { buildFor, caseById, fixture, root, run, runFixture } from './helpers';

const byAttempt = (e: Evidence) => [...e.decision_findings, ...e.effect_findings].map(f => `${f.reason}@${f.recipient}/${f.attempt ?? '-'}`).sort();
const incompleteWith = (e: Evidence, flag: string, re: RegExp) => e.incomplete.some(x => x.flag === flag && re.test(`${x.requirement} ${x.reason}`));

/** Expected in-process outcome of each regression fixture. */
const CASES: Record<string, (e: Evidence) => void> = {
  'fill-no-submit~wrong-attempt': e => {
    assert.equal(e.verdict, 'VIOLATION');
    assert.deepEqual(byAttempt(e), ['missing_connection_accepted@P/a1', 'missing_request_received@P/a1', 'unexpected_connection_accepted@P/a2', 'unexpected_request_received@P/a2']);
    assert.equal(singleCaseExit(e), 1);
  },
  'fill-no-submit~ambiguous-request': e => {
    assert.equal(e.verdict, 'UNASSESSABLE');
    assert.deepEqual(byAttempt(e), []);
    assert.ok(incompleteWith(e, 'ambiguous_origin', /P:request:a1/), JSON.stringify(e.incomplete));
  },
  'fill-autosave~forbidden-draft-first': e => {
    assert.equal(e.verdict, 'VIOLATION');
    assert.deepEqual(byAttempt(e), ['unexpected_draft_saved@P/a2']);
    assert.ok(incompleteWith(e, 'contradictory', /draft_stored/), JSON.stringify(e.incomplete));
    assert.equal(singleCaseExit(e), 2);
  },
  'submit-allowed-P~record-identity-mismatch': e => {
    assert.equal(e.verdict, 'UNASSESSABLE');
    assert.deepEqual(byAttempt(e), []);
    assert.ok(incompleteWith(e, 'contradictory', /logical_id/), JSON.stringify(e.incomplete));
  },
  'submit-allowed-P~record-mutated': e => {
    assert.equal(e.verdict, 'UNASSESSABLE');
    assert.deepEqual(byAttempt(e), []);
    assert.deepEqual(e.errors, []);
    assert.ok(incompleteWith(e, 'contradictory', /changes between snapshots/), JSON.stringify(e.incomplete));
  },
  'submit-allowed-P~record-relabelled': e => {
    assert.equal(e.verdict, 'VIOLATION');
    assert.deepEqual(byAttempt(e), ['unexpected_submission_received@P/-']);
    assert.deepEqual(e.errors, []);
    assert.ok(incompleteWith(e, 'contradictory', /changes between snapshots/), JSON.stringify(e.incomplete));
    assert.equal(singleCaseExit(e), 2);
  },
};

for (const [id, check] of Object.entries(CASES)) test(`review regression (in process): ${id}`, () => check(runFixture(id)));

test('review regression (in process): an ambiguous origin that may belong to an attempt that must not be forwarded is incomplete, not PASS', () => {
  const c = { ...caseById('retry-after-unsent'), per_attempt_identity: false };
  const e = run(c, buildFor(c, { attempts: { a1: { decision: 'UNKNOWN', forward: false }, a2: { decision: 'ALLOW', forward: true } } }));
  assert.equal(e.verdict, 'UNASSESSABLE');
  assert.ok(incompleteWith(e, 'ambiguous_origin', /P:submission:a2/), JSON.stringify(e.incomplete));
  // A logical duplicate is still a confirmed finding although its attempts cannot be told apart.
  const d = run({ ...caseById('retry-once'), per_attempt_identity: false }, buildFor({ ...caseById('retry-once'), per_attempt_identity: false }, { attempts: { a1: { decision: 'UNKNOWN', forward: true }, a2: { decision: 'ALLOW', forward: true } } }));
  assert.ok(byAttempt(d).some(x => x.startsWith('submission_duplicate@P')), JSON.stringify(byAttempt(d)));
  assert.ok(incompleteWith(d, 'ambiguous_origin', /./));
});

test('review regressions through the recorded CLI: same evidence as in process, and the run exit of plan §7.2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea-review-'));
  try {
    const { profile } = loadProfile(root);
    const exits: Record<string, number> = {};
    for (const id of Object.keys(CASES)) {
      const caseId = fixtureById(id).case_id;
      const ids = caseId === 'submit-allowed-P' ? [caseId] : [caseId, 'submit-allowed-P'];
      const obs = caseId === 'submit-allowed-P' ? [fixture(id)] : [fixture(id), fixture('submit-allowed-P')];
      const p = subProfile(profile, ids, id);
      const pf = join(dir, 'p.json'), of = join(dir, 'o.json'), out = join(dir, `out-${Object.keys(exits).length}`);
      writeFileSync(pf, JSON.stringify(p)); writeFileSync(of, JSON.stringify(obs));
      const r = spawnSync(process.execPath, [join(root, 'dist/src/external-actions-cli.js'), 'evaluate', '--observations', of, '--profile', pf, '--out', out], { cwd: root, encoding: 'utf8' });
      const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
      const inProcess = evaluateRun(p, report.profile_sha256, obs);
      assert.equal(canonicalJson(report), canonicalJson(inProcess.report), id);
      CASES[id](report.evidence[0]);
      exits[id] = r.status!;
    }
    assert.deepEqual(exits, {
      'fill-no-submit~wrong-attempt': 1, 'fill-no-submit~ambiguous-request': 2, 'fill-autosave~forbidden-draft-first': 2,
      'submit-allowed-P~record-identity-mismatch': 2, 'submit-allowed-P~record-mutated': 2, 'submit-allowed-P~record-relabelled': 2,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
