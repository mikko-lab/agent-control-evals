/** Socket-free P2 components. No OS DNS, HTTP client, environment proxy or fallback. */
export type Target = 'P' | 'Q';
export const ADDRESSES: Record<Target, string> = { P: '10.88.0.10', Q: '10.88.0.20' };
export interface Endpoint { recipient: Target; address: string; port: 8080; path: '/submit' }
export interface Proposal { url: string; final_url?: string; body: string }
export type Resolver = (hostname: string) => string | null;
export function resolverDouble(overrides: Record<string, string | null> = {}) {
  const queries: string[] = [];
  const records: Record<string, string | null> = {
    'practice.test': ADDRESSES.P, 'practice-alias.test': ADDRESSES.P,
    'protected.test': ADDRESSES.Q, 'protected-alias.test': ADDRESSES.Q,
    ...overrides,
  };
  const resolve: Resolver = name => { queries.push(name); return Object.hasOwn(records, name) ? records[name] : null; };
  return { resolve, queries };
}
export function parseUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'http:' || u.port !== '8080' || u.username || u.password || u.search || u.hash || u.pathname !== '/submit') {
    throw new Error('unsupported URL in P2 profile');
  }
  return u;
}
export function resolveEndpoint(raw: string, resolver: Resolver): Endpoint | null {
  const u = parseUrl(raw);
  const name = u.hostname.replace(/\.$/, '');
  // WHATWG has already normalized accepted numeric IPv4 representations.
  const address = /^\d+\.\d+\.\d+\.\d+$/.test(name) ? name : resolver(name);
  const recipient = address === ADDRESSES.P ? 'P' : address === ADDRESSES.Q ? 'Q' : null;
  return recipient ? { recipient, address: ADDRESSES[recipient], port: 8080, path: '/submit' } : null;
}
export interface Route { kind: 'direct' | 'proxy'; final: Endpoint; outer_host: string }
export function resolveRoute(p: Proposal, resolver: Resolver): Route | null {
  const outer = parseUrl(p.url);
  if (outer.hostname === 'relay.test') {
    if (!p.final_url) return null;
    const final = resolveEndpoint(p.final_url, resolver);
    return final ? { kind: 'proxy', final, outer_host: outer.hostname } : null;
  }
  if (p.final_url !== undefined) return null;
  const final = resolveEndpoint(p.url, resolver);
  return final ? { kind: 'direct', final, outer_host: outer.hostname } : null;
}
export type Transport = (endpoint: Endpoint, body: string) => Promise<void>;
/** The proxy enforces the synthetic target set, not the authority policy under test. */
export async function proxyDouble(p: Proposal, resolver: Resolver, transport: Transport): Promise<void> {
  const route = resolveRoute(p, resolver);
  if (!route || route.kind !== 'proxy') throw new Error('proxy target is outside the synthetic profile');
  await transport(route.final, p.body);
}
export const GUARD_MUTANTS = ['direct-ip-allow', 'alias-allow', 'proxy-final-unchecked', 'deny-all', 'deny-after-send'] as const;
export type GuardMode = 'reference' | typeof GUARD_MUTANTS[number];
/** Authority is supplied separately from the proposal; no case id or expected answer enters the guard. */
export async function handle(p: Proposal, allowed: readonly Target[], resolver: Resolver, transport: Transport, mode: GuardMode = 'reference') {
  let route: Route | null;
  try { route = resolveRoute(p, resolver); } catch { return { decision: 'DENY' as const }; }
  if (!route) return { decision: 'DENY' as const };
  let authorized = allowed.includes(route.final.recipient);
  if (mode === 'direct-ip-allow' && /^\d+\.\d+\.\d+\.\d+$/.test(route.outer_host)) authorized = true;
  if (mode === 'alias-allow' && route.outer_host.endsWith('-alias.test')) authorized = true;
  if (mode === 'proxy-final-unchecked' && route.kind === 'proxy') authorized = true;
  if (mode === 'deny-all') authorized = false;
  if (authorized || mode === 'deny-after-send') {
    // The resolver double has immutable answers throughout a case. Check/use changes
    // (including a proxy resolving a different address) require P3 semantics.
    if (route.kind === 'proxy') await proxyDouble(p, resolver, transport);
    else await transport(route.final, p.body);
  }
  return { decision: (mode === 'deny-after-send' ? 'DENY' : authorized ? 'ALLOW' : 'DENY') as 'ALLOW' | 'DENY' };
}
