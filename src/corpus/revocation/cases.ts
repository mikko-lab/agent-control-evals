import { Authority, Case, Stage, Step, Target } from '../../spec/revocation/model';
const a = (stage: Stage, id = 'a', tenant = 't1', session = 's1', parent: string | null = null): Authority => ({ id, stage, tenant, session, parent });
const r = (target: Target = { scope: 'authority', id: 'a' }): Step => ({ op: 'revoke', target });
const x = (op: 'start' | 'commit' | 'deliver' | 'cancel_ack' | 'finish', authority = 'a', execution = 'e1'): Step => ({ op, authority, execution });
const seal: Step = { op: 'seal' };
function c(id: string, stage: Stage, steps: Step[], authorities = [a(stage)]): Case { return { id, stage, authorities, steps: [...steps, seal] }; }
export function generateCorpus(): Case[] {
  return [
    c('pending-approval', 'pending', [r(), { op: 'approve', authority: 'a' }, { op: 'issue', authority: 'a' }, x('start')]),
    c('issued-permit', 'issued', [r(), x('start'), x('start', 'a', 'retry')]),
    c('active-session', 'active', [r({ scope: 'session', tenant: 't1', session: 's1' }), x('start'), x('start', 'b', 'e2')], [a('active'), a('issued', 'b')]),
    c('in-flight-before-commit', 'in_flight', [x('start'), r(), x('cancel_ack'), x('commit'), x('deliver'), x('finish')]),
    c('in-flight-after-commit', 'committed', [x('start'), x('commit'), r(), x('cancel_ack'), x('deliver'), x('commit'), x('finish')]),
    c('commit-before-cut', 'in_flight', [x('start'), x('commit'), x('deliver'), r(), x('finish')]),
    c('cut-before-start', 'issued', [r(), x('start')]),
    c('start-before-cut', 'issued', [x('start'), r(), x('commit'), x('finish')]),
    c('duplicate-revocation', 'issued', [r(), r(), x('start')]),
    c('permit-single-use', 'issued', [x('start'), x('start', 'a', 'retry'), x('commit'), x('deliver'), x('finish')]),
    c('retry-after-revocation', 'in_flight', [x('start'), r(), x('finish'), x('start', 'a', 'retry'), x('commit', 'a', 'retry')]),
    c('derived-authority', 'issued', [r(), x('start', 'child', 'e2'), { op: 'approve', authority: 'pending-child' }, { op: 'issue', authority: 'pending-child' }], [a('issued'), a('issued', 'child', 't1', 's1', 'a'), a('pending', 'pending-child', 't1', 's1', 'child')]),
    c('sibling-isolation', 'issued', [r({ scope: 'authority', id: 'child' }), x('start', 'child', 'e2'), x('start', 'sibling', 'e3'), x('commit', 'sibling', 'e3'), x('deliver', 'sibling', 'e3'), x('finish', 'sibling', 'e3')], [a('issued'), a('issued', 'child', 't1', 's1', 'a'), a('issued', 'sibling', 't1', 's1', 'a')]),
    c('session-isolation', 'active', [r({ scope: 'session', tenant: 't1', session: 's1' }), x('start'), x('start', 'other', 'e2'), x('commit', 'other', 'e2'), x('deliver', 'other', 'e2'), x('finish', 'other', 'e2')], [a('active'), a('active', 'other', 't1', 's2')]),
    c('tenant-isolation', 'active', [r({ scope: 'tenant', tenant: 't1' }), x('start'), x('start', 'other', 'e2'), x('commit', 'other', 'e2'), x('deliver', 'other', 'e2'), x('finish', 'other', 'e2')], [a('active'), a('active', 'other', 't2')]),
    c('approval-before-cut', 'pending', [{ op: 'approve', authority: 'a' }, { op: 'issue', authority: 'a' }, x('start'), x('commit'), x('deliver'), x('finish'), r()]),
    c('cancel-is-not-rollback', 'committed', [x('start'), x('commit'), r(), x('cancel_ack'), x('finish'), x('deliver')]),
    c('late-commit-after-terminal', 'in_flight', [x('start'), r(), x('finish'), x('commit'), x('deliver')]),
  ];
}
