/**
 * Harness-owned automotive corpus entry (auto-corpus-entry-0.2.0).
 *
 * The oracle output lives next to the case, never inside it: AutomotiveCase keeps
 * its PR A shape, and the adapter-visible view is derived from `entry.case` only
 * (toAutomotiveAdapterView), so `expected` cannot leak through it.
 */
import type { AUTOMOTIVE_CORPUS_ENTRY_VERSION } from "../../spec/automotive/version";
import type { AutomotiveExpected } from "../../oracle/automotive/types";
import type { AutomotiveCase } from "../automotive/types";

export interface AutomotiveCorpusEntry {
  corpus_entry_version: typeof AUTOMOTIVE_CORPUS_ENTRY_VERSION;
  case: AutomotiveCase;
  expected: AutomotiveExpected;
}
