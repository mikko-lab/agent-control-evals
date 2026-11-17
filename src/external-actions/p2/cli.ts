import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../util/canonical-json';
import { sha256Hex } from '../../util/hash';
import { componentReport } from './components';
import { provenance } from './provenance';
import { validateP2Report } from './report-schema';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('usage: p2/cli.js --out NEW_DIRECTORY');
  const out = resolve(args[1]);
  const build = provenance();
  const report = await componentReport();
  validateP2Report(report);
  const bytes = canonicalJson(report) + '\n';
  // Exclusive new directory: never overwrite a frozen report.
  mkdirSync(out, { recursive: false });
  writeFileSync(join(out, 'report.json'), bytes, { flag: 'wx' });
  writeFileSync(join(out, 'manifest.json'), canonicalJson({ format: 'p2-component-manifest/2', report_sha256: sha256Hex(bytes), build }) + '\n', { flag: 'wx' });
  console.log(canonicalJson({ component_gate_passed: report.component_gate_passed, p2_acceptance: false, integration: 'NOT RUN', out }));
  process.exitCode = report.component_gate_passed ? 0 : 1;
}
if (require.main === module) void main().catch(e => { console.error(String(e)); process.exitCode = 2; });
