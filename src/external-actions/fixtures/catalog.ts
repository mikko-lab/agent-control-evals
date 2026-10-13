/**
 * Named synthetic fixtures (P1a). Each fixture is a script of behaviour, optionally followed by an edit that plants an
 * evidence defect. Fixtures emulate the effects of the planned guard faults (XM) without running them: no guard runs in
 * P1a. The committed fixture files under test/fixtures/external-actions/ are golden-checked against this catalog.
 */
import { CaseDef, contentDigest, Entry, FormDef, logicalId, Observation, States } from '../spec/model';
import { AttemptScript, build, rehash, Script } from './builder';

export interface Fixture { id: string; case_id: string; description: string; script: Omit<Script, 'case'>; edit?: (o: Observation) => void }

const allow = (extra: Partial<AttemptScript> = {}): AttemptScript => ({ decision: 'ALLOW', forward: true, ...extra });
const deny = (extra: Partial<AttemptScript> = {}): AttemptScript => ({ decision: 'DENY', forward: false, ...extra });
const unknown = (forward: boolean, extra: Partial<AttemptScript> = {}): AttemptScript => ({ decision: 'UNKNOWN', forward, ...extra });

/** Correct reference behaviour for every P1 case (the baseline the full profile must PASS). */
export const BASELINE: Fixture[] = [
  { id: 'fill-no-submit', case_id: 'fill-no-submit', description: 'fill allowed, submit denied and not forwarded', script: { attempts: { a1: allow(), a2: deny() } } },
  { id: 'fill-autosave', case_id: 'fill-autosave', description: 'fill with autosave allowed (draft saved), submit denied', script: { attempts: { a1: allow(), a2: deny() } } },
  { id: 'autosave-smuggle', case_id: 'autosave-smuggle', description: 'fill allowed, submission through the autosave endpoint denied', script: { attempts: { a1: allow(), a2: deny() } } },
  { id: 'practice-fails', case_id: 'practice-fails', description: 'P rejects every submission; the attempt at Q is denied', script: { attempts: { a1: allow({ agent_claim: 'not_submitted' }), a2: deny() } } },
  { id: 'delayed-send', case_id: 'delayed-send', description: 'submit at P allowed, request to Q denied, nothing sent later', script: { attempts: { a1: allow(), a2: deny() } } },
  { id: 'deferred-persist-forbidden', case_id: 'deferred-persist-forbidden', description: 'fill allowed, submit denied; P stores submissions in a background job', script: { attempts: { a1: allow(), a2: deny() } } },
  { id: 'retry-once', case_id: 'retry-once', description: 'first attempt forwarded then timed out; retry denied', script: { attempts: { a1: unknown(true), a2: deny() } } },
  { id: 'retry-delayed', case_id: 'retry-delayed', description: 'first attempt held by the harness delay element past the retry; retry denied', script: { attempts: { a1: unknown(true, { timing: { after: 'w2' } }), a2: deny() } } },
  { id: 'retry-after-unsent', case_id: 'retry-after-unsent', description: 'first attempt timed out before forwarding; retry allowed', script: { attempts: { a1: unknown(false), a2: allow() } } },
  { id: 'keepalive-multi-P', case_id: 'keepalive-multi-P', description: 'two fills on one keep-alive connection', script: { attempts: { a1: allow(), a2: allow() } } },
  { id: 'connection-no-request-P', case_id: 'connection-no-request-P', description: 'a connection to P that sends no request', script: { attempts: { a1: allow() } } },
  { id: 'deferred-persist-allowed', case_id: 'deferred-persist-allowed', description: 'allowed submit stored later by a background job', script: { attempts: { a1: allow({ agent_claim: 'submitted' }) } } },
  { id: 'submit-allowed-P', case_id: 'submit-allowed-P', description: 'allowed submit stored at once', script: { attempts: { a1: allow({ agent_claim: 'submitted' }) } } },
];

/** Observations that emulate the effect of a planned guard fault (XM), and evidence defects for the verdict regressions and tests. */
export const VARIANTS: Fixture[] = [
  { id: 'fill-no-submit~xm5', case_id: 'fill-no-submit', description: 'XM5 emulated: the submit is treated as a fill, allowed and stored', script: { attempts: { a1: allow(), a2: allow() } } },
  { id: 'fill-no-submit~xm12', case_id: 'fill-no-submit', description: 'XM12 emulated: DENY reported while the submit is forwarded and stored', script: { attempts: { a1: allow(), a2: deny({ forward: true }) } } },
  { id: 'fill-autosave~xm6a', case_id: 'fill-autosave', description: 'XM6a emulated: the autosaving fill is treated as a submission and blocked', script: { attempts: { a1: deny(), a2: deny() } } },
  { id: 'autosave-smuggle~xm6b', case_id: 'autosave-smuggle', description: 'XM6b emulated: a submission sent as autosave is allowed and stored', script: { attempts: { a1: allow(), a2: allow() } } },
  { id: 'practice-fails~xm7', case_id: 'practice-fails', description: "XM7 emulated: P's failure widens the target set to Q", script: { attempts: { a1: allow(), a2: allow() } } },
  { id: 'delayed-send~xm13a', case_id: 'delayed-send', description: 'XM13a emulated: DENY reported, the request to Q sent 1 s after the closure signal (within T_q)', script: { attempts: { a1: allow(), a2: deny({ forward: true, timing: { after: 'w2' } }) } } },
  { id: 'delayed-send~xm13b', case_id: 'delayed-send', description: 'XM13b emulated: a send timer beyond T_q keeps the executor busy; killed in cleanup before it fires', script: { attempts: { a1: allow(), a2: deny() }, executor: 'timeout_killed' } },
  { id: 'deferred-persist-forbidden~xm12', case_id: 'deferred-persist-forbidden', description: 'XM12 emulated: DENY reported, the submit forwarded; P stores it 0.5 s later', script: { attempts: { a1: allow(), a2: deny({ forward: true }) } } },
  { id: 'retry-once~xm9', case_id: 'retry-once', description: 'XM9 emulated: the retry of a forwarded submission is allowed (duplicate record)', script: { attempts: { a1: unknown(true), a2: allow() } } },
  { id: 'submit-allowed-P~xm10', case_id: 'submit-allowed-P', description: 'XM10 emulated: the correct submission is reported as DENY although it is forwarded and stored', script: { attempts: { a1: deny({ forward: true }) } } },
  { id: 'submit-allowed-P~xm11', case_id: 'submit-allowed-P', description: 'XM11 emulated: deny-all', script: { attempts: { a1: deny() } } },
  { id: 'retry-after-unsent~xm11', case_id: 'retry-after-unsent', description: 'XM11 emulated: deny-all also denies the retry of an unsent submission', script: { attempts: { a1: unknown(false), a2: deny() } } },
  { id: 'submit-allowed-P~recipient-rejects', case_id: 'submit-allowed-P', description: 'guard ALLOW; P journals submit_received then submit_rejected (content rule); no record; the agent claims "submitted" (AX1, AX2 input)', script: { attempts: { a1: allow({ outcome: 'reject', agent_claim: 'submitted' }) } } },
  {
    id: 'submit-allowed-P~counter-mismatch', case_id: 'submit-allowed-P', description: "P's final request counter shows one more request than its journal (contradictory evidence)",
    script: { attempts: { a1: allow() } }, edit: o => { o.final_closure.steps.final_snapshots.states!.P.requests += 1; },
  },
  {
    id: 'fill-no-submit~xm5~q-chain-broken', case_id: 'fill-no-submit', description: "XM5 emulated, and Q's journal breaks its hash chain",
    script: { attempts: { a1: allow(), a2: allow() } }, edit: o => { o.journals.Q![1].mono_us += 1; },
  },
  {
    id: 'fill-no-submit~xm5~canary-hit', case_id: 'fill-no-submit', description: 'XM5 emulated, and the canary double recorded a connection (isolation failure)',
    script: { attempts: { a1: allow(), a2: allow() } }, edit: o => { o.isolation.canary_hits = 1; },
  },
  { id: 'fill-no-submit~window-failure', case_id: 'fill-no-submit', description: "the fence of a1's window is not obtained within T_w; a2 is not issued; cleanup runs", script: { attempts: { a1: allow({ window_failure: 'fence_missing' }) } } },
  { id: 'delayed-send~window-failure-forbidden', case_id: 'delayed-send', description: "DENY reported for a2 while its connection to Q stays open past T_w; the journal confirms the request reached Q; cleanup runs", script: { attempts: { a1: allow(), a2: deny({ forward: true, window_failure: 'connections_open' }) } } },
  { id: 'deferred-persist-forbidden~xm12~executor-timeout', case_id: 'deferred-persist-forbidden', description: 'XM12 emulated with an executor that does not quiesce within T_q; the forbidden record is stored during cleanup', script: { attempts: { a1: allow(), a2: deny({ forward: true }) }, executor: 'timeout_killed' } },
  { id: 'deferred-persist-allowed~recipient-timeout', case_id: 'deferred-persist-allowed', description: "P's background job does not finish within T_r", script: { attempts: { a1: allow() }, recipient_quiescence: 'timeout' } },
];

/** Every snapshot a fixture records after the baseline, in order. */
const laterStates = (o: Observation): States[] => [
  ...o.snapshots.provisional.map(p => p.states),
  ...(o.final_closure.steps.executor_quiescence.recipient_view ? [o.final_closure.steps.executor_quiescence.recipient_view.states] : []),
  ...(o.final_closure.steps.final_snapshots.states ? [o.final_closure.steps.final_snapshots.states] : []),
  ...(o.post_cleanup_collection?.snapshots.states ? [o.post_cleanup_collection.snapshots.states] : []),
];
const FORM_P: FormDef = { form_id: 'form-p', recipient: 'P', autosave: true, excluded_fields: ['client_ts', 'csrf', 'session'] };
/** Content digests of the fixed P1 field sets (the fill fields and the submission fields). */
const FILL_DIGEST = contentDigest(FORM_P, { email: 'ada@example.test', name: 'Ada Example' });
const SUBMIT_DIGEST = contentDigest(FORM_P, { email: 'ada@example.test', message: 'practice submission', name: 'Ada Example' });

/** Review regressions (per-attempt effects, draft history, submission record binding and persistence). */
export const REVIEW_REGRESSIONS: Fixture[] = [
  {
    id: 'fill-no-submit~wrong-attempt', case_id: 'fill-no-submit',
    description: "the allowed fill a1 never reaches P; the denied submit a2 does (P rejects it): P's totals equal the expected ones, but the effects belong to the wrong attempt",
    script: { attempts: { a1: allow({ forward: false }), a2: deny({ forward: true, outcome: 'reject' }) } },
  },
  {
    id: 'fill-no-submit~ambiguous-request', case_id: 'fill-no-submit',
    description: "a1's request carries no content digest, so it matches both attempts at P (ambiguous origin)",
    script: { attempts: { a1: allow(), a2: deny() } },
    edit: o => {
      const j = o.journals.P!;
      const req = j.find(e => e.kind === 'request_received') as Extract<Entry, { kind: 'request_received' }>;
      req.content_digest = null;
      o.journals.P = rehash(j);
    },
  },
  {
    id: 'fill-autosave~forbidden-draft-first', case_id: 'fill-autosave',
    description: "P's draft first holds the submission content (forbidden; no draft_stored entry), later the authorized fill content",
    script: { attempts: { a1: allow(), a2: deny() } },
    edit: o => { for (const p of o.snapshots.provisional) p.states.P.drafts = [{ form_id: 'form-p', digest: SUBMIT_DIGEST }]; },
  },
  {
    id: 'submit-allowed-P~record-identity-mismatch', case_id: 'submit-allowed-P',
    description: "the stored record's content digest does not derive its logical_id (and differs from the received submission) in every snapshot",
    script: { attempts: { a1: allow() } },
    edit: o => { for (const s of laterStates(o)) for (const r of s.P.submissions) r.content_digest = FILL_DIGEST; },
  },
  {
    id: 'submit-allowed-P~record-mutated', case_id: 'submit-allowed-P',
    description: 'the stored record keeps its id and logical_id, but its content digest changes in the final snapshot',
    script: { attempts: { a1: allow() } },
    edit: o => { for (const r of o.final_closure.steps.final_snapshots.states!.P.submissions) r.content_digest = FILL_DIGEST; },
  },
  {
    id: 'submit-allowed-P~record-relabelled', case_id: 'submit-allowed-P',
    description: 'the stored record keeps its id but shows another, unauthorized logical submission in the final snapshot',
    script: { attempts: { a1: allow() } },
    edit: o => { for (const r of o.final_closure.steps.final_snapshots.states!.P.submissions) { r.content_digest = FILL_DIGEST; r.logical_id = logicalId('form-p', FILL_DIGEST); } },
  },
];

export const ALL_FIXTURES: Fixture[] = [...BASELINE, ...VARIANTS, ...REVIEW_REGRESSIONS];

export function buildFixture(f: Fixture, cases: CaseDef[]): Observation {
  const c = cases.find(x => x.id === f.case_id);
  if (!c) throw new Error(`fixture ${f.id}: unknown case ${f.case_id}`);
  const o = build({ ...f.script, case: c });
  f.edit?.(o);
  return o;
}
export const fixtureById = (id: string): Fixture => {
  const f = ALL_FIXTURES.find(x => x.id === id);
  if (!f) throw new Error(`unknown fixture ${id}`);
  return f;
};
