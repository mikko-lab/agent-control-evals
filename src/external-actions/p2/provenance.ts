import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest } from './live-model';
export function provenance() {
  const build = resolve(__dirname, '../../..');
  const raw = readFileSync(join(build, 'provenance.json'), 'utf8');
  const p = JSON.parse(raw);
  if (p.format !== 'p2-build-provenance/1') throw new Error('clean P2 build provenance required');
  for (const f of p.compiled) if (digest(readFileSync(join(build, f.path), 'utf8')) !== f.sha256) throw new Error(`compiled artifact changed: ${f.path}`);
  for (const f of p.sources) if (digest(readFileSync(f.path, 'utf8')) !== f.sha256) throw new Error(`source changed since build: ${f.path}`);
  return { ...p, execution_node: process.version, execution_platform: process.platform, provenance_sha256: digest(raw) };
}
