/**
 * Specification-only oracle for the external-actions track. It reads case definitions and nothing else: no
 * observation, fixture, evaluator or filesystem module is in its import closure (checked by
 * src/external-actions/oracle-boundary.ts).
 */
import { actionClass, AttemptContribution, CaseDef, contentDigest, Expected, ExpectedAttempt, formOf, logicalId, Recipient, RECIPIENTS } from '../spec/model';

/**
 * Expected guard decision and recipient effects for every attempt (plan §5.7, §7.1):
 * - a harness-induced timeout makes the decision UNKNOWN; the attempt is forwarded when the timeout came after forwarding;
 * - a submission whose logical identity was already forwarded in the case is a retry and must be denied;
 * - otherwise an attempt is allowed exactly when a grant covers its recipient and action class.
 * A forwarded attempt leaves a connection (unless it reuses a keep-alive connection), a request (unless it only
 * connects), a draft (a fill of an autosave form) or a submission record (unless its recipient rejects submissions).
 */
export function expected(c: CaseDef): Expected {
  const forwardedLogical = new Set<string>();
  const openConnections = new Set<string>();
  const attempts: ExpectedAttempt[] = [];
  const contributions: AttemptContribution[] = [];
  for (const a of c.attempts) {
    const cls = actionClass(a.action);
    const form = formOf(c, a.form_id);
    if (form.recipient !== a.recipient) throw new Error(`case ${c.id}: attempt ${a.id} targets ${a.recipient} with a form of ${form.recipient}`);
    const digest = a.action === 'connect_only' ? null : contentDigest(form, a.fields);
    const logical = cls === 'submit' && digest !== null ? logicalId(a.form_id, digest) : null;
    const authorized = c.grants.some(g => g.recipient === a.recipient && g.actions.includes(cls));
    let decision: ExpectedAttempt['decision'];
    let forwarded: boolean;
    if (a.conditions.includes('guard_timeout_after_forward')) { decision = 'UNKNOWN'; forwarded = true; }
    else if (a.conditions.includes('guard_timeout_before_forward')) { decision = 'UNKNOWN'; forwarded = false; }
    else if (logical !== null && forwardedLogical.has(logical)) { decision = 'DENY'; forwarded = false; }
    else { decision = authorized ? 'ALLOW' : 'DENY'; forwarded = authorized; }
    if (forwarded && logical !== null) forwardedLogical.add(logical);
    attempts.push({ attempt: a.id, decision, forwarded, content_digest: digest, logical_id: logical });
    if (!forwarded) continue;
    const key = `${a.recipient}/${a.connection}`;
    const newConnection = !openConnections.has(key);
    openConnections.add(key);
    contributions.push({
      attempt: a.id, recipient: a.recipient,
      connection: newConnection ? a.connection : null,
      request: a.action !== 'connect_only',
      draft: a.action === 'fill' && form.autosave && digest !== null ? { form_id: a.form_id, digest } : null,
      submission: logical !== null && c.recipient_modes[a.recipient] !== 'failing' ? logical : null,
    });
  }
  const forms = Object.fromEntries(RECIPIENTS.map(r => [r, c.forms.filter(f => f.recipient === r).map(f => f.form_id).sort()])) as Record<Recipient, string[]>;
  return { case_id: c.id, attempts, contributions, forms, rejecting: RECIPIENTS.filter(r => c.recipient_modes[r] === 'failing') };
}

/** Expected state at one recipient, from the contributions of the given attempts only. */
export interface RecipientExpectation { connections: number; requests: number; drafts: Map<string, string | null>; submissions: Map<string, number> }
export function expectedAt(truth: Expected, recipient: Recipient, attempts: ReadonlySet<string>): RecipientExpectation {
  const mine = truth.contributions.filter(x => x.recipient === recipient && attempts.has(x.attempt));
  const drafts = new Map<string, string | null>(truth.forms[recipient].map(f => [f, null]));
  const submissions = new Map<string, number>();
  for (const x of mine) {
    if (x.draft) drafts.set(x.draft.form_id, x.draft.digest);
    if (x.submission) submissions.set(x.submission, (submissions.get(x.submission) ?? 0) + 1);
  }
  return { connections: mine.filter(x => x.connection !== null).length, requests: mine.filter(x => x.request).length, drafts, submissions };
}
