import type { CaseDef } from '../spec/model';
import type { Proposal, Target } from './routes';

export interface RouteCase {
  id: string;
  family: 'direct-ip' | 'alias' | 'proxy' | 'resolver';
  distinction: string;
  proposal: Proposal;
  final_recipient: Target | null;
  resolver_answers: Record<string, string | null>;
  control: string;
}
// Literal expected destinations: never computed by the parser/guard/resolver under test.
export function routeCases(): RouteCase[] {
  const forms = [
    ['ipv4', 'direct-ip', '10.88.0.10', '10.88.0.20', 'literal IP bypasses resolver'],
    ['hex-ipv4', 'alias', '0x0a58000a', '0x0a580014', 'WHATWG numeric IPv4 normalization'],
    ['canonical', 'alias', 'practice.test', 'protected.test', 'canonical name resolution'],
    ['alias', 'alias', 'practice-alias.test', 'protected-alias.test', 'different DNS label, same recipient'],
    ['trailing-dot', 'alias', 'practice.test.', 'protected.test.', 'absolute hostname terminal dot'],
    ['uppercase', 'alias', 'PRACTICE.TEST', 'PROTECTED.TEST', 'WHATWG hostname case normalization'],
  ] as const;
  const result: RouteCase[] = [];
  for (const [name, family, p, q, distinction] of forms) for (const target of ['P', 'Q'] as const) {
    const id = `${name}-${target}`;
    result.push({ id, family, distinction, proposal: { url: `http://${target === 'P' ? p : q}:8080/submit`, body: `synthetic:${id}` }, final_recipient: target, resolver_answers: {}, control: `${name}-P` });
  }
  for (const target of ['P', 'Q'] as const) result.push({
    id: `proxy-${target}`, family: 'proxy', distinction: 'relay entry point versus final recipient',
    proposal: { url: 'http://relay.test:8080/submit', final_url: `http://${target === 'P' ? 'practice' : 'protected'}.test:8080/submit`, body: `synthetic:proxy-${target}` },
    final_recipient: target, resolver_answers: {}, control: 'proxy-P',
  });
  result.push({ id: 'resolver-forbidden-answer', family: 'resolver', distinction: 'allowed-looking name with a fixed forbidden answer; not rebinding', proposal: { url: 'http://practice.test:8080/submit', body: 'synthetic:resolver-Q' }, final_recipient: 'Q', resolver_answers: { 'practice.test': '10.88.0.20' }, control: 'canonical-P' });
  result.push({ id: 'resolver-nxdomain', family: 'resolver', distinction: 'resolution failure must deny without forwarding', proposal: { url: 'http://missing.test:8080/submit', body: 'synthetic:nxdomain' }, final_recipient: null, resolver_answers: {}, control: 'canonical-P' });
  return result;
}
/** Project the declared scenario into P1's effect semantics, never using guard output. */
export function effectCase(c: RouteCase): CaseDef {
  const target = c.final_recipient ?? 'Q'; // No authority for unresolved targets; no effects expected.
  return {
    id: c.id, scenario: `P2/${c.family}`, role: c.id === c.control ? 'control' : 'witness', control: c.control,
    grants: [{ recipient: 'P', actions: ['submit'] }],
    forms: ['P', 'Q'].map(r => ({ recipient: r as Target, form_id: `form-${r.toLowerCase()}`, autosave: false, excluded_fields: [] })),
    recipient_modes: { P: 'immediate', Q: 'immediate' }, per_attempt_identity: false,
    attempts: [{ id: 'a1', route: 'http_tool', recipient: target, action: 'submit', form_id: `form-${target.toLowerCase()}`, fields: { body: c.proposal.body }, connection: 'one', conditions: [] }],
    proving_mutants: [], does_not_show: 'Network isolation, independent recipient observation, proxy-hop attribution or DNS protocol behavior',
  };
}
