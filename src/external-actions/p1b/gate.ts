/**
 * P1b XM mutant gate (decisions, "Gate"). Filled in below the guard loader.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { P1B_PATHS } from './config';
import { patchIssues } from './patch';

export const MUTANT_RULES: Record<string, string> = {
  XM5: 'authorize', XM6a: 'classify', XM6b: 'classify', XM7: 'authorize', XM9: 'dedup', XM10: 'report', XM11: 'authorize', XM12: 'forward_gate', XM13a: 'forward_gate', XM13b: 'forward_gate',
};

/** The guard source for `reference` or an XM id; a mutant's patch must be confined to its rule. */
export function guardSource(root: string, id: string): string {
  const reference = readFileSync(join(root, P1B_PATHS.guard), 'utf8');
  if (id === 'reference') return reference;
  const rule = MUTANT_RULES[id];
  if (!rule) throw new Error(`unknown guard mutant ${id}`);
  const r = patchIssues(reference, readFileSync(join(root, P1B_PATHS.patches, `${id}.patch`), 'utf8'), rule);
  if (!r.mutated) throw new Error(`mutant ${id} rejected: ${r.issues.join('; ')}`);
  return r.mutated;
}
