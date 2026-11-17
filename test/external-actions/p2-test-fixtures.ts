import { routeCases } from '../../src/external-actions/p2/corpus';
import { digest, Event, eventHash, ips, LiveRun, roles, Role } from '../../src/external-actions/p2/live-model';
import { filter } from '../../src/external-actions/p2/topology';
// Explicitly SYNTHETIC schema/evaluator inputs. Never included as live-run evidence.
export function fixture(): LiveRun {
  const config = JSON.stringify(Object.fromEntries([...roles, 'b'].map(r => [r, { addresses: r === 'b' ? 'bridge' : `inet ${ips[r as Role]}/24`, routes: '', filter: r === 'b' ? '' : filter(r as Role), ipv6: '1', forwarding: '0', drops: '' }])));
  return { format: 'external-action-p2-live-run/1', evidence_kind: 'local_recipient_observation', run_id: 'synthetic-unit-fixture', node: 'v22.0.0', platform: 'linux', guard: 'reference', cases: routeCases().map(c => {
    const id = { run: 'synthetic-unit-fixture', case: c.id, attempt: 'a1' as const };
    const events: Record<Role, Event[]> = { e: [], x: [], r: [], p: [], q: [] };
    const emit = (role: Role, kind: string, data: Record<string, unknown>) => {
      const stream = events[role]; const e = { ...id, service: role, seq: stream.length, prev: stream.at(-1)?.hash ?? '0'.repeat(64), kind, data };
      stream.push({ ...e, hash: eventHash(e) });
    };
    const allowed = c.final_recipient === 'P', proxy = c.family === 'proxy';
    const numeric = c.id.startsWith('ipv4-') || c.id.startsWith('hex-ipv4-');
    const name = c.id === 'resolver-nxdomain' ? 'missing.test' : c.id === 'resolver-forbidden-answer' ? 'practice.test'
      : c.id.startsWith('alias-') ? (allowed ? 'practice-alias.test' : 'protected-alias.test') : allowed ? 'practice.test' : 'protected.test';
    if (!numeric) for (const peer of proxy && allowed ? [ips.e, ips.x] : [ips.e]) {
      emit('r', 'connection', { peer, address: ips.r });
      emit('r', 'request', { peer, method: 'POST', path: '/resolve', body: JSON.stringify({ name }) });
      emit('r', 'answer', { name, address: c.final_recipient === 'P' ? ips.p : c.final_recipient === 'Q' ? ips.q : null });
    }
    if (allowed) {
      if (proxy) { emit('x', 'connection', { peer: ips.e, address: ips.x }); emit('x', 'request', { peer: ips.e, method: 'POST', path: '/submit', body: JSON.stringify({ final_url: c.proposal.final_url, body: c.proposal.body }) }); }
      const peer = proxy ? ips.x : ips.e;
      emit('p', 'connection', { peer, address: ips.p }); emit('p', 'request', { peer, method: 'POST', path: '/submit', body: c.proposal.body }); emit('p', 'stored', { peer, address: ips.p, body: c.proposal.body });
    }
    emit('e', 'decision', { decision: allowed ? 'ALLOW' : 'DENY' });
    const states: Record<string, { records: string[]; open: number; active: number }> = {};
    for (const role of ['x', 'r', 'p', 'q'] as const) { states[role] = { records: role === 'p' && allowed ? [c.proposal.body] : [], open: 0, active: 0 }; emit(role, 'closed', states[role]); }
    return { ...id, decision: allowed ? 'ALLOW' as const : 'DENY' as const, events, states, processes: roles.map(role => ({ role, code: 0, signal: null, timed_out: false })), isolation: { before: config, after: config, before_hash: digest(config), after_hash: digest(config), probes: Object.fromEntries(roles.map(r => [r, true])), channels_before: true, channels_after: true }, errors: [] };
  }) };
}
export function rechain(events: Event[]) { let prev = '0'.repeat(64); events.forEach((e, i) => { e.seq = i; e.prev = prev; e.hash = eventHash(e); prev = e.hash; }); }
