import { ips, Role, roles } from './live-model';
export function filter(role: Role): string {
  const edges: Record<Role, Role[]> = { e: ['p', 'q', 'x', 'r'], x: ['p', 'q', 'r'], r: [], p: [], q: [] };
  return ['*filter', ':INPUT DROP [0:0]', ':FORWARD DROP [0:0]', ':OUTPUT DROP [0:0]',
    '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT', '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    ...roles.filter(r => edges[r].includes(role)).map(r => `-A INPUT -s ${ips[r]}/32 -d ${ips[role]}/32 -p tcp --dport 8080 -j ACCEPT`),
    ...edges[role].map(r => `-A OUTPUT -s ${ips[role]}/32 -d ${ips[r]}/32 -p tcp --dport 8080 -j ACCEPT`),
    '-A INPUT -j DROP', '-A OUTPUT -j DROP', 'COMMIT', ''].join('\n');
}
const normalize = (s: string) => s.split('\n').filter(l => l && !l.startsWith('#'))
  .map(l => l.replace(/ -m tcp/g, '').replace(/RELATED,ESTABLISHED/g, 'ESTABLISHED,RELATED'))
  // iptables-save groups chains. Preserve rule order WITHIN each chain.
  .sort((a, b) => (a.startsWith('-A ') ? a.split(' ').slice(0, 2).join(' ') : a).localeCompare(b.startsWith('-A ') ? b.split(' ').slice(0, 2).join(' ') : b)).join('\n');
export interface Configuration { addresses: string; routes: string; filter: string; ipv6: string; forwarding: string; drops: string }
export function configurationIssues(text: string): string[] {
  let values: Record<string, Configuration>;
  try { values = JSON.parse(text); } catch { return ['configuration_not_json']; }
  const errors: string[] = [];
  if (!values || Object.keys(values).sort().join(',') !== 'b,e,p,q,r,x') return ['configuration_roles'];
  for (const r of [...roles, 'b' as const]) {
    const v = values[r];
    if (!v || typeof v.addresses !== 'string' || typeof v.routes !== 'string' || typeof v.filter !== 'string' || typeof v.drops !== 'string') { errors.push(`configuration_shape:${r}`); continue; }
    if (v.ipv6.trim() !== '1' || v.forwarding.trim() !== '0' || /default/.test(v.routes)) errors.push(`network_configuration:${r}`);
    if (r === 'b') {
      if (/\binet6?\s/.test(v.addresses)) errors.push('bridge_has_address');
    } else {
      const addresses = [...v.addresses.matchAll(/\binet\s+(\S+)/g)].map(m => m[1]);
      if (addresses.length !== 1 || addresses[0] !== `${ips[r]}/24` || /\binet6\s/.test(v.addresses)) errors.push(`addresses:${r}`);
      if (normalize(v.filter) !== normalize(filter(r))) errors.push(`filter:${r}`);
    }
  }
  return errors;
}
