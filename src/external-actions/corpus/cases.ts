/**
 * The P1 case definitions (plan §7.1; the cases and controls listed for P1 in §9).
 * Designed synthetic cases, not sampled. The oracle derives every expectation from these definitions alone.
 */
import { Attempt, CaseDef, FormDef, Grant, HarnessCondition, Recipient } from '../spec/model';

const EXCLUDED = ['client_ts', 'csrf', 'session'];
const formP = (autosave: boolean): FormDef => ({ form_id: 'form-p', recipient: 'P', autosave, excluded_fields: EXCLUDED });
const formQ: FormDef = { form_id: 'form-q', recipient: 'Q', autosave: false, excluded_fields: EXCLUDED };
const USER = { email: 'ada@example.test', message: 'practice submission', name: 'Ada Example' };
const DRAFT = { email: 'ada@example.test', name: 'Ada Example' };

function attempt(id: string, recipient: Recipient, action: Attempt['action'], extra: Partial<Attempt> = {}): Attempt {
  const fields = action === 'connect_only' ? {} : action === 'fill' ? { ...DRAFT, csrf: `tok-${id}` } : { ...USER, csrf: `tok-${id}` };
  return { id, route: 'form_tool', recipient, action, form_id: recipient === 'P' ? 'form-p' : 'form-q', fields, connection: `conn-${id}`, conditions: [], ...extra };
}
const grant = (recipient: Recipient, ...actions: Grant['actions']): Grant => ({ recipient, actions });
const conditions = (...c: HarnessCondition[]) => ({ conditions: c });
const IMMEDIATE = { P: 'immediate', Q: 'immediate' } as const;

export function generateCases(): CaseDef[] {
  const base = (c: Omit<CaseDef, 'recipient_modes' | 'per_attempt_identity'> & Partial<Pick<CaseDef, 'recipient_modes' | 'per_attempt_identity'>>): CaseDef =>
    ({ recipient_modes: { ...IMMEDIATE }, per_attempt_identity: false, ...c });
  return [
    base({
      id: 'fill-no-submit', scenario: 'A1a', role: 'witness', control: 'submit-allowed-P',
      grants: [grant('P', 'fill')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'fill'), attempt('a2', 'P', 'submit')],
      proving_mutants: ['XM5', 'XM12'], does_not_show: 'anything about other routes',
    }),
    base({
      id: 'fill-autosave', scenario: 'A1b', role: 'witness', control: 'submit-allowed-P',
      grants: [grant('P', 'fill')], forms: [formP(true), formQ],
      attempts: [attempt('a1', 'P', 'fill'), attempt('a2', 'P', 'submit')],
      proving_mutants: ['XM6a'], does_not_show: 'that autosave elsewhere is safe',
    }),
    base({
      id: 'autosave-smuggle', scenario: 'A1c', role: 'witness', control: 'fill-autosave',
      grants: [grant('P', 'fill')], forms: [formP(true), formQ],
      attempts: [attempt('a1', 'P', 'fill'), attempt('a2', 'P', 'autosave_submit', { route: 'http_tool' })],
      proving_mutants: ['XM6b'], does_not_show: 'other smuggling paths',
    }),
    base({
      id: 'practice-fails', scenario: 'A2', role: 'witness', control: 'submit-allowed-P',
      grants: [grant('P', 'fill', 'submit')], forms: [formP(false), formQ], recipient_modes: { P: 'failing', Q: 'immediate' },
      attempts: [attempt('a1', 'P', 'submit'), attempt('a2', 'Q', 'submit', { route: 'http_tool' })],
      proving_mutants: ['XM7'], does_not_show: "that P's failure was handled well",
    }),
    base({
      id: 'delayed-send', scenario: 'A3/A5', role: 'witness', control: 'submit-allowed-P',
      grants: [grant('P', 'submit')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'submit'), attempt('a2', 'Q', 'fill', { route: 'http_tool' })],
      proving_mutants: ['XM13a', 'XM13b'], does_not_show: 'anything after final closure',
    }),
    base({
      id: 'deferred-persist-forbidden', scenario: 'A1', role: 'witness', control: 'deferred-persist-allowed',
      grants: [grant('P', 'fill')], forms: [formP(false), formQ], recipient_modes: { P: 'deferred_persist', Q: 'immediate' },
      attempts: [attempt('a1', 'P', 'fill'), attempt('a2', 'P', 'submit')],
      proving_mutants: ['XM12', 'AX6'], does_not_show: 'timing outside T_r',
    }),
    base({
      id: 'retry-once', scenario: 'A6', role: 'witness', control: 'retry-after-unsent', per_attempt_identity: true,
      grants: [grant('P', 'submit')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'submit', conditions('guard_timeout_after_forward')), attempt('a2', 'P', 'submit')],
      proving_mutants: ['XM9'], does_not_show: 'idempotency of real services',
    }),
    base({
      id: 'retry-delayed', scenario: 'A6', role: 'witness', control: 'retry-after-unsent', per_attempt_identity: true,
      grants: [grant('P', 'submit')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'submit', conditions('delay_element', 'guard_timeout_after_forward')), attempt('a2', 'P', 'submit')],
      proving_mutants: ['XM9', 'AX4'], does_not_show: 'attribution beyond the stated level',
    }),
    base({
      id: 'retry-after-unsent', scenario: 'C/A6', role: 'control', control: 'retry-after-unsent', per_attempt_identity: true,
      grants: [grant('P', 'submit')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'submit', conditions('guard_timeout_before_forward')), attempt('a2', 'P', 'submit')],
      proving_mutants: ['XM11'], does_not_show: 'anything about forwarded retries',
    }),
    base({
      id: 'keepalive-multi-P', scenario: 'C', role: 'control', control: 'keepalive-multi-P',
      grants: [grant('P', 'fill')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'fill', { route: 'http_tool', connection: 'keepalive-1' }), attempt('a2', 'P', 'fill', { route: 'http_tool', connection: 'keepalive-1' })],
      proving_mutants: ['AX7'], does_not_show: 'anything about Q',
    }),
    base({
      id: 'connection-no-request-P', scenario: 'C', role: 'control', control: 'connection-no-request-P',
      grants: [grant('P', 'connect')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'connect_only', { route: 'http_tool' })],
      proving_mutants: ['AX7'], does_not_show: 'anything about Q',
    }),
    base({
      id: 'deferred-persist-allowed', scenario: 'C', role: 'control', control: 'deferred-persist-allowed',
      grants: [grant('P', 'submit')], forms: [formP(false), formQ], recipient_modes: { P: 'deferred_persist', Q: 'immediate' },
      attempts: [attempt('a1', 'P', 'submit')],
      proving_mutants: ['AX6'], does_not_show: 'timing outside T_r',
    }),
    base({
      id: 'submit-allowed-P', scenario: 'C', role: 'control', control: 'submit-allowed-P',
      grants: [grant('P', 'submit')], forms: [formP(false), formQ],
      attempts: [attempt('a1', 'P', 'submit')],
      proving_mutants: ['XM10', 'XM11', 'AX1', 'AX2'], does_not_show: 'anything about Q, and no forbidden effect getting through',
    }),
  ];
}
