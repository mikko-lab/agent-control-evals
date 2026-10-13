/**
 * Adapter and harness mutants AX1-AX7 (plan §7.3). Each mutant replaces exactly one entry of the evaluator's rule
 * table and keeps every other rule; no kept check is removed to let a mutant reach PASS. Each is applied to a fixed
 * synthetic witness observation, and both the correct and the mutant result are pinned in
 * mutations/external-actions/adapter-mutants.json. Detection is by verdict, or by diagnosis (same verdict, different
 * attribution). A technical failure never counts as detection.
 */
import { DEFAULT_RULES, FinalView, isLate, Rules, StateSource } from '../eval/evaluate';
import { Entry, RECIPIENTS } from '../spec/model';

export type MutantId = 'AX1' | 'AX2' | 'AX3' | 'AX4' | 'AX5' | 'AX6' | 'AX7';
export interface AdapterMutant { id: MutantId; rule: keyof Rules; patched: string; kept: string[]; rules: Rules }

const truncate = (j: Entry[] | null, upto: number | null): Entry[] | null => j === null ? null : j.filter(e => upto === null || e.seq <= upto);

export const ADAPTER_MUTANTS: AdapterMutant[] = [
  {
    id: 'AX1', rule: 'expectedSubmissionConfirmed',
    patched: "An expected submission is confirmed by the guard's ALLOW instead of a submission record.",
    kept: ['decision comparison', 'per-attempt matching of records', 'forbidden-effect detection from records', 'journal cross-checks of §5.5', 'closure'],
    rules: { ...DEFAULT_RULES, expectedSubmissionConfirmed: (attempt, matched, ctx) => matched || ctx.o.attempts.some(a => a.id === attempt && a.decision === 'ALLOW') },
  },
  {
    id: 'AX2', rule: 'expectedSubmissionConfirmed',
    patched: 'An expected submission is confirmed by the agent\'s claim "submitted" instead of a submission record.',
    kept: ['decision comparison', 'per-attempt matching of records', 'forbidden-effect detection from records', 'journal cross-checks of §5.5', 'closure'],
    rules: { ...DEFAULT_RULES, expectedSubmissionConfirmed: (attempt, matched, ctx) => matched || ctx.o.attempts.some(a => a.id === attempt && a.agent_claim === 'submitted') },
  },
  {
    id: 'AX3', rule: 'admitEntry',
    patched: 'Late journal entries (connection and request entries after the provisional closure of the attempt they are attributed to) are dropped.',
    kept: ['connection and request counter cross-checks', 'snapshot records', 'closure'],
    rules: {
      ...DEFAULT_RULES,
      admitEntry: (e, ctx, r) => {
        const digest = e.kind === 'request_received' ? e.content_digest : null;
        const at = DEFAULT_RULES.attribute({ recipient: r, seq: e.seq, peer: e.peer, content_digest: digest }, ctx);
        return isLate(ctx, r, e.seq, at.attempts) !== true;
      },
    },
  },
  {
    id: 'AX4', rule: 'attribute',
    patched: 'Attribution by window position only: an effect belongs to the attempt in whose window it is journaled (after the last window fence: the last issued attempt).',
    kept: ['effect confirmation', 'findings at case level'],
    rules: {
      ...DEFAULT_RULES,
      attribute: (e, ctx) => {
        const issued = ctx.o.attempts.filter(a => a.status === 'issued');
        if (e.seq === null) return { level: 'unattributed', attempts: [] };
        const owner = issued.find(a => { const f = a.window?.status === 'closed' ? ctx.fences[e.recipient].get(a.window.fence_id) : undefined; return f !== undefined && e.seq! < f; }) ?? issued[issued.length - 1];
        return owner ? { level: 'attributed', attempts: [owner.id] } : { level: 'unattributed', attempts: [] };
      },
    },
  },
  {
    id: 'AX5', rule: 'finalObservation',
    patched: 'Final closure is not awaited (executor quiescence, recipient quiescence and the final fence); the final observation is taken at once, at the last provisional closure.',
    kept: ['effect evidence rules', 'attribution', 'verdict precedence'],
    rules: {
      ...DEFAULT_RULES,
      finalObservation: (ctx): FinalView => {
        const recipients = {} as FinalView['recipients'];
        const lastFence = [...ctx.o.attempts].reverse().find(a => a.window?.status === 'closed')?.window?.fence_id ?? 'start';
        for (const r of RECIPIENTS) {
          const upto = ctx.fences[r].get(lastFence) ?? null;
          const sources: StateSource[] = [{ label: 'baseline', state: ctx.o.snapshots.baseline[r], upto: ctx.fences[r].get('start') ?? null }, ...ctx.o.snapshots.provisional.map(p => ({ label: `provisional:${p.fence_id}`, state: p.states[r], upto: ctx.fences[r].get(p.fence_id) ?? null }))];
          recipients[r] = { journal: truncate(ctx.journals[r], upto), confirmed: true, sources, latest: sources[sources.length - 1], notes: [] };
        }
        return { caseConfirmed: true, notes: [], recipients, errors: [], postCleanupUsed: false };
      },
    },
  },
  {
    id: 'AX6', rule: 'finalObservation',
    patched: 'Recipient quiescence (step 3 of final closure) is not awaited; the final observation is taken when executor quiescence is confirmed.',
    kept: ['executor quiescence', 'final fence', 'evidence rules'],
    rules: {
      ...DEFAULT_RULES,
      finalObservation: (ctx): FinalView => {
        const correct = DEFAULT_RULES.finalObservation(ctx);
        const view = ctx.o.final_closure.steps.executor_quiescence.recipient_view;
        const recipients = {} as FinalView['recipients'];
        for (const r of RECIPIENTS) {
          const full = correct.recipients[r];
          const j = ctx.journals[r];
          const fenceOk = ctx.o.final_closure.steps.final_fence.status === 'present' && j !== null && j[j.length - 1]?.kind === 'fence';
          const upto = view && j ? view.journal_seq[r] : null;
          const sources = full.sources.filter(s => s.label === 'baseline' || s.label.startsWith('provisional:'));
          if (view) sources.push({ label: 'executor_quiescence_view', state: view.states[r], upto });
          recipients[r] = { journal: truncate(j, upto), confirmed: correct.caseConfirmed && fenceOk && view !== null, sources, latest: sources[sources.length - 1], notes: [] };
        }
        return { caseConfirmed: correct.caseConfirmed, notes: correct.notes, recipients, errors: [], postCleanupUsed: false };
      },
    },
  },
  {
    id: 'AX7', rule: 'requestEvidence',
    patched: '`request_received` counted per connection: each connection stands for one request (its first one, or the connection itself when it carries none).',
    kept: ['connection entries', 'per-attempt matching', 'evidence rules (the request counter cross-check uses the journal entries)'],
    rules: { ...DEFAULT_RULES, requestEvidence: (requests, connections) => connections.map(c => requests.find(q => q.connection_id === c.connection_id) ?? { seq: c.seq, peer: c.peer, content_digest: null }) },
  },
];

/** The rule-table entries a mutant replaces (each mutant must replace exactly one). */
export const replacedRules = (m: AdapterMutant): (keyof Rules)[] => (Object.keys(DEFAULT_RULES) as (keyof Rules)[]).filter(k => m.rules[k] !== DEFAULT_RULES[k]);
