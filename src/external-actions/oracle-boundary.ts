/**
 * Static import-boundary check for the external-actions oracle (plan §8: the existing oracle boundary check reused as a
 * pattern, with new roots). The transitive import closure of src/external-actions/oracle/** and
 * src/external-actions/corpus/** may reach only the external-actions spec, oracle and corpus, canonical JSON and
 * hashing. It must not reach the evaluator, fixtures, mutants, report, CLI, any other track, a Node built-in other than
 * node:crypto (and node:fs in src/util/hash.ts, which the oracle modules themselves never import), or an external package.
 *
 * This file is a build-time checker; it is not part of the closure it checks.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface BoundaryResult { ok: boolean; roots: string[]; closure: string[]; violations: { file: string; import: string; reason: string }[] }

const ALLOWED = ['src/external-actions/spec/', 'src/external-actions/oracle/', 'src/external-actions/corpus/', 'src/util/canonical-json.ts', 'src/util/hash.ts'];
const ALLOWED_BUILTINS = new Set(['node:crypto']);
const HASH_FILE_EXCEPTION = 'src/util/hash.ts';

function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap(e => { const p = join(dir, e); return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : []; });
}
export function importsOf(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  if (/\brequire\s*\(\s*[^"'\s)]/.test(src) || /\bimport\s*\(\s*[^"'\s)]/.test(src)) out.push('<dynamic-import>');
  return out;
}

export function checkExternalActionsOracleBoundary(root: string): BoundaryResult {
  const rel = (p: string) => relative(root, p).split('\\').join('/');
  const roots = [...listTs(join(root, 'src/external-actions/oracle')), ...listTs(join(root, 'src/external-actions/corpus'))].map(rel).sort();
  const seen = new Set<string>();
  const violations: BoundaryResult['violations'] = [];
  const queue = [...roots];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const imp of importsOf(readFileSync(join(root, f), 'utf8'))) {
      if (imp === '<dynamic-import>') { violations.push({ file: f, import: imp, reason: 'dynamic require/import is not allowed in the oracle closure' }); continue; }
      if (!imp.startsWith('.')) {
        if (ALLOWED_BUILTINS.has(imp) || (f === HASH_FILE_EXCEPTION && imp === 'node:fs')) continue;
        violations.push({ file: f, import: imp, reason: 'external package or Node built-in outside the allowlist' });
        continue;
      }
      let target = rel(resolve(dirname(join(root, f)), imp));
      if (target.endsWith('.json')) { violations.push({ file: f, import: imp, reason: `oracle closure reads data file ${target}` }); continue; }
      if (!target.endsWith('.ts')) target = `${target}.ts`;
      if (!ALLOWED.some(p => target.startsWith(p))) { violations.push({ file: f, import: imp, reason: `module ${target} is outside the oracle allowlist` }); continue; }
      queue.push(target);
    }
  }
  for (const f of seen) {
    if (f !== HASH_FILE_EXCEPTION && importsOf(readFileSync(join(root, f), 'utf8')).some(i => i === 'node:fs' || i === 'fs' || i === 'node:fs/promises')) {
      violations.push({ file: f, import: 'node:fs', reason: 'oracle closure module reads the filesystem' });
    }
  }
  return { ok: violations.length === 0, roots, closure: [...seen].sort(), violations };
}
