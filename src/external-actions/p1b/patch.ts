/**
 * XM mutant patches (decisions, "Reference guard and mutants"): unified diffs against the reference guard, applied
 * exactly (no fuzz). A patch is accepted only when every line it removes lies strictly inside the named rule block
 * (`// RULE <name> BEGIN` ... `// RULE <name> END`) of the reference guard, and every line it adds is inserted there.
 */
interface Op { kind: ' ' | '-' | '+'; text: string; oldLine: number }
interface Hunk { oldStart: number; ops: Op[] }

export function parsePatch(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let old = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('diff ') || l.startsWith('index ')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (h) { cur = { oldStart: Number(h[1]), ops: [] }; old = cur.oldStart; hunks.push(cur); continue; }
    if (!cur || l === '' || l === '\\ No newline at end of file') continue;
    const kind = l[0];
    if (kind !== ' ' && kind !== '-' && kind !== '+') throw new Error(`unexpected patch line: ${l}`);
    // An added line is inserted before old line `old`.
    cur.ops.push({ kind, text: l.slice(1), oldLine: old });
    if (kind !== '+') old++;
  }
  if (!hunks.length) throw new Error('patch has no hunks');
  return hunks;
}

/** Rule blocks of the reference guard: name -> [BEGIN line, END line] (1-based). */
export function ruleBlocks(source: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const open = new Map<string, number>();
  source.split('\n').forEach((l, i) => {
    const b = /\/\/ RULE ([a-z_]+) BEGIN$/.exec(l); if (b) open.set(b[1], i + 1);
    const e = /\/\/ RULE ([a-z_]+) END$/.exec(l); if (e && open.has(e[1])) out.set(e[1], [open.get(e[1])!, i + 1]);
  });
  return out;
}

export function applyPatch(source: string, patch: string): { result: string; ops: Op[] } {
  const src = source.split('\n');
  const hunks = parsePatch(patch);
  const out: string[] = [];
  let next = 1;
  const ops: Op[] = [];
  for (const h of hunks) {
    if (h.oldStart < next) throw new Error('overlapping hunks');
    while (next < h.oldStart) out.push(src[next++ - 1]);
    for (const op of h.ops) {
      ops.push(op);
      if (op.kind === '+') { out.push(op.text); continue; }
      if (src[op.oldLine - 1] !== op.text) throw new Error(`patch does not apply at line ${op.oldLine}: expected ${JSON.stringify(op.text)}, found ${JSON.stringify(src[op.oldLine - 1])}`);
      if (op.kind === ' ') out.push(op.text);
      next = op.oldLine + 1;
    }
  }
  while (next <= src.length) out.push(src[next++ - 1]);
  return { result: out.join('\n'), ops };
}

/** Problems of a mutant patch: it must apply, change something, and change lines inside its named rule only. */
export function patchIssues(source: string, patch: string, rule: string): { issues: string[]; mutated: string | null } {
  const blocks = ruleBlocks(source);
  const block = blocks.get(rule);
  if (!block) return { issues: [`rule ${rule} is not a rule block of the reference guard`], mutated: null };
  let applied: ReturnType<typeof applyPatch>;
  try { applied = applyPatch(source, patch); } catch (e) { return { issues: [String(e)], mutated: null }; }
  const issues: string[] = [];
  if (applied.result === source) issues.push('the patch changes nothing');
  for (const op of applied.ops) {
    if (op.kind === '-' && !(op.oldLine > block[0] && op.oldLine < block[1])) issues.push(`removed line ${op.oldLine} is outside rule ${rule} (lines ${block[0] + 1}-${block[1] - 1})`);
    if (op.kind === '+' && !(op.oldLine > block[0] && op.oldLine <= block[1])) issues.push(`a line added before ${op.oldLine} is outside rule ${rule}`);
  }
  if ([...ruleBlocks(applied.result).entries()].map(([k]) => k).sort().join(',') !== [...blocks.keys()].sort().join(',')) issues.push('the patch changes the rule markers');
  return { issues, mutated: issues.length ? null : applied.result };
}
