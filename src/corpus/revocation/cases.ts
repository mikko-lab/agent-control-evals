import { Authority, Case, Family, InitialGrant, Step, Target } from '../../spec/revocation/model';
const a = (id = 'a', initial: InitialGrant = 'issued', tenant = 't1', session = 's1', parent: string | null = null): Authority => ({ id, initial, tenant, session, parent });
const r = (target: Target = { scope: 'authority', id: 'a' }): Step => ({ op: 'revoke', target });
const session = (session = 's1', tenant = 't1'): Target => ({ scope: 'session', tenant, session });
const x = (op: 'start' | 'commit' | 'deliver' | 'cancel_ack' | 'finish', authority = 'a', execution = 'e1'): Step => ({ op, authority, execution });
const g = (op: 'approve' | 'issue', authority = 'a'): Step => ({ op, authority });
const seal: Step = { op: 'seal' };
function c(id: string, family: Family, steps: Step[], authorities = [a()]): Case { return { id, family, authorities, steps: [...steps, seal] }; }
/**
 * Designed revocation-0.2.0 corpus. Every execution a faulty runtime could start has an explicit finish request,
 * so terminal evidence never comes from the seal itself. Purposes and sole-revocation claims are in ./design.
 */
export function generateCorpus(): Case[] {
  return [
    c('pending-approval', 'pending_approval', [r(), g('approve'), g('issue'), x('start'), x('finish')], [a('a', 'pending')]),
    c('issue-after-cut', 'pending_approval', [g('approve'), r(), g('issue'), x('start'), x('finish')], [a('a', 'pending')]),
    c('issued-permit', 'issued_permit', [r(), x('start'), x('start', 'a', 'retry'), x('finish'), x('finish', 'a', 'retry')]),
    c('fresh-id-retry-unused-permit', 'issued_permit', [x('start'), g('approve'), g('issue'), r(), x('start', 'a', 'retry'), x('finish'), x('finish', 'a', 'retry')], [a('a', 'pending')]),
    c('cut-before-start', 'issued_permit', [r(), x('start'), x('finish')]),
    c('duplicate-revocation', 'issued_permit', [r(), r(), x('start'), x('finish')]),
    c('active-session', 'active_session', [r(session()), x('start'), x('start', 'b', 'e2'), x('finish'), x('finish', 'b', 'e2')], [a(), a('b')]),
    c('session-in-flight-commit-fence', 'active_session', [x('start'), x('start', 'o', 'e2'), r(session()), x('commit'), x('commit', 'o', 'e2'), x('deliver', 'o', 'e2'), x('finish'), x('finish', 'o', 'e2')], [a(), a('o', 'issued', 't1', 's2')]),
    c('session-delivery-fence-after-commit', 'active_session', [x('start'), x('commit'), r(session()), x('deliver'), x('finish')]),
    c('tenant-multi-session-in-flight', 'active_session', [x('start'), x('start', 'b', 'e2'), x('start', 'c', 'e3'), r({ scope: 'tenant', tenant: 't1' }), x('commit'), x('commit', 'b', 'e2'), x('commit', 'c', 'e3'), x('deliver', 'c', 'e3'), x('finish'), x('finish', 'b', 'e2'), x('finish', 'c', 'e3')], [a(), a('b', 'issued', 't1', 's2'), a('c', 'issued', 't2', 's1')]),
    c('start-before-cut', 'in_flight_before_commit', [x('start'), r(), x('commit'), x('finish')]),
    c('in-flight-before-commit', 'in_flight_before_commit', [x('start'), r(), x('cancel_ack'), x('commit'), x('deliver'), x('finish')]),
    c('late-commit-after-terminal', 'in_flight_before_commit', [x('start'), r(), x('finish'), x('commit'), x('deliver')]),
    c('retry-after-revocation', 'in_flight_before_commit', [x('start'), r(), x('finish'), x('start', 'a', 'retry'), x('commit', 'a', 'retry'), x('finish', 'a', 'retry')]),
    c('in-flight-after-commit', 'in_flight_after_commit', [x('start'), x('commit'), r(), x('cancel_ack'), x('deliver'), x('commit'), x('finish')]),
    c('commit-before-cut', 'in_flight_after_commit', [x('start'), x('commit'), x('deliver'), r(), x('finish')]),
    c('commit-shift-across-cut', 'in_flight_after_commit', [x('start'), x('commit'), r(), x('cancel_ack'), x('finish')]),
    c('cancel-is-not-rollback', 'in_flight_after_commit', [x('start'), x('commit'), r(), x('cancel_ack'), x('finish'), x('deliver')]),
    c('derived-authority', 'descendant_scope', [r(), x('start', 'child', 'e2'), g('approve', 'pending-child'), g('issue', 'pending-child'), x('finish', 'child', 'e2')], [a(), a('child', 'issued', 't1', 's1', 'a'), a('pending-child', 'pending', 't1', 's1', 'child')]),
    c('derived-in-flight-ancestor-revoked', 'descendant_scope', [x('start', 'child', 'e2'), r(), x('commit', 'child', 'e2'), x('finish', 'child', 'e2')], [a(), a('child', 'issued', 't1', 's1', 'a')]),
    c('sibling-isolation', 'scope_isolation', [r({ scope: 'authority', id: 'child' }), x('start', 'child', 'e2'), x('start', 'sibling', 'e3'), x('commit', 'sibling', 'e3'), x('deliver', 'sibling', 'e3'), x('finish', 'sibling', 'e3'), x('finish', 'child', 'e2'), x('start'), x('finish')], [a(), a('child', 'issued', 't1', 's1', 'a'), a('sibling', 'issued', 't1', 's1', 'a')]),
    c('session-isolation', 'scope_isolation', [r(session()), x('start'), x('start', 'other', 'e2'), x('commit', 'other', 'e2'), x('deliver', 'other', 'e2'), x('finish', 'other', 'e2'), x('finish')], [a(), a('other', 'issued', 't1', 's2')]),
    c('tenant-isolation', 'scope_isolation', [r({ scope: 'tenant', tenant: 't1' }), x('start'), x('start', 'other', 'e2'), x('commit', 'other', 'e2'), x('deliver', 'other', 'e2'), x('finish', 'other', 'e2'), x('finish')], [a(), a('other', 'issued', 't2')]),
    c('execution-id-reuse', 'identity', [x('start'), x('start', 'b', 'e1'), x('commit', 'b', 'e1'), x('finish', 'b', 'e1'), x('commit'), x('finish')], [a(), a('b')]),
    c('permit-single-use', 'control', [x('start'), x('start', 'a', 'retry'), x('commit'), x('deliver'), x('finish'), x('finish', 'a', 'retry')]),
    c('approval-before-cut', 'control', [g('approve'), g('issue'), x('start'), x('commit'), x('deliver'), x('finish'), r()], [a('a', 'pending')]),
    c('deferred-terminal-before-seal', 'observation_timing', [x('start'), r(), x('cancel_ack'), x('finish'), x('commit')]),
  ];
}
