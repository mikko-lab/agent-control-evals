'use strict';
/**
 * External Action Boundary Evaluation, P1b: synthetic reference guard (decisions D1 and "P1b decisions").
 *
 * The guard sits between the agent's tools and the network. For each attempt it classifies the action, authorizes it
 * against the case's grants, denies retries of a logical submission it has already forwarded, forwards allowed
 * requests through the executor environment and reports its decision. It keeps one decision and retry state for the
 * whole case.
 *
 * The rules are delimited by `// RULE <name> BEGIN` and `// RULE <name> END`. Each XM mutant patch
 * (mutations/external-actions/guard/<id>.patch) changes lines inside exactly one rule; the gate checks this before a
 * mutant runs. Code outside the rule blocks is shared by the reference guard and every mutant.
 *
 * This is harness code: a planted-fault reference, not a security product.
 */
const { createHash } = require('node:crypto');

/** Canonical JSON with sorted keys (the guard's own copy; it shares no code with the doubles or the evaluator). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const sha256 = s => createHash('sha256').update(s).digest('hex');

/** Logical submission identity as the guard computes it from the request it is asked to send (plan §5.7). */
function logicalIdOf(form, fields) {
  const user = {};
  for (const k of Object.keys(fields).sort()) if (!form.excluded_fields.includes(k)) user[k] = fields[k];
  return sha256(form.form_id + '\u0000' + sha256(canonical(user)));
}

/**
 * @param policy { grants: [{ recipient, actions: ('fill'|'submit'|'connect')[] }], forms: [{ form_id, recipient, autosave, excluded_fields }] }
 * @param env    { forward(attempt) -> Promise<{ status }>, event(name, attemptId, detail),
 *                 afterSignal(attemptId, delayMs, fn): runs fn delayMs after the closure signal of the attempt's window,
 *                 timing: { xm13a_delay_ms, xm13b_delay_ms } }
 * An attempt is the request the agent asks the guard to send: { id, route, recipient, host, method, path (null for a
 * connection without a request), fields, connection, keep_open }.
 */
module.exports = function createGuard(policy, env) {
  /** Case-wide state: logical submissions already forwarded, and recipients whose forward failed. */
  const state = { forwarded: new Set(), failedRecipients: new Set() };
  const formOf = path => { const m = /^\/forms\/([^/]+)\//.exec(path || ''); return m ? policy.forms.find(f => f.form_id === m[1]) : undefined; };
  const granted = (recipient, cls) => policy.grants.some(g => g.recipient === recipient && g.actions.includes(cls));

  function classify(attempt) {
    const form = formOf(attempt.path);
    // RULE classify BEGIN
    if (attempt.path === null) return 'connect';
    if (attempt.method !== 'POST' || !form) return 'other';
    if (attempt.path.endsWith('/autosave')) return 'submit';
    if (attempt.path.endsWith('/submit')) return 'submit';
    if (attempt.path.endsWith('/fill')) return 'fill';
    return 'other';
    // RULE classify END
  }

  function authorize(attempt, cls) {
    // RULE authorize BEGIN
    return granted(attempt.recipient, cls);
    // RULE authorize END
  }

  function dedup(cls, logical) {
    // RULE dedup BEGIN
    if (cls === 'submit' && logical !== null && state.forwarded.has(logical)) return 'DENY';
    return null;
    // RULE dedup END
  }

  async function send(attempt, logical) {
    if (logical !== null) state.forwarded.add(logical);
    env.event('forward_started', attempt.id, null);
    const result = await env.forward(attempt);
    env.event('forward_done', attempt.id, { status: result.status });
    if (result.status >= 500) state.failedRecipients.add(attempt.recipient);
    return result;
  }

  async function forwardGate(attempt, decision, logical) {
    // RULE forward_gate BEGIN
    if (decision !== 'ALLOW') return null;
    return send(attempt, logical);
    // RULE forward_gate END
  }

  function report(decision, cls, result) {
    // RULE report BEGIN
    return decision;
    // RULE report END
  }

  return {
    /** Handles one attempt; resolves with the answer the guard reports to the agent. */
    async handle(attempt) {
      const cls = classify(attempt);
      const form = formOf(attempt.path);
      const logical = cls === 'submit' && form && attempt.fields ? logicalIdOf(form, attempt.fields) : null;
      const decision = dedup(cls, logical) ?? (cls !== 'other' && authorize(attempt, cls) ? 'ALLOW' : 'DENY');
      const result = await forwardGate(attempt, decision, logical);
      return { decision: report(decision, cls, result), status: result ? result.status : null };
    },
  };
};
