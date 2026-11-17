import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../util/canonical-json';
import { evaluateLive, liveMutationDetected } from './live-evaluate';
import { linuxRun } from './linux-run';
import { GuardMode } from './routes';
import { provenance } from './provenance';
import { validateP2Report } from './report-schema';
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'run' && args.length >= 2 && args.length <= 3) {
    const build = provenance();
    const run = await linuxRun(args[0], args[1] as GuardMode, args[2]);
    writeFileSync(join(args[0], 'build.json'), canonicalJson(build) + '\n', { flag: 'wx' });
    const report = evaluateLive(run);
    validateP2Report(report);
    console.log(canonicalJson({ run: run.run_id, run_passed: report.run_passed, mutation_detected: liveMutationDetected(report), p2_acceptance: false }));
    process.exitCode = report.cases.some(c => c.errors.length || c.incomplete.length) ? 2 : report.run_passed || liveMutationDetected(report) ? 0 : 1;
  } else if (command === 'evaluate' && args.length === 2) {
    const report = evaluateLive(JSON.parse(readFileSync(args[0], 'utf8')));
    validateP2Report(report);
    mkdirSync(args[1]); writeFileSync(join(args[1], 'report.json'), canonicalJson(report) + '\n', { flag: 'wx' });
    process.exitCode = report.cases.some(c => c.errors.length || c.incomplete.length) ? 2 : 0;
  } else throw new Error('usage: live-cli run NEW_OUT GUARD [INJECTION] | evaluate RAW_JSON NEW_OUT');
}
if (require.main === module) main().catch(e => { console.error(String(e)); process.exitCode = 2; });
