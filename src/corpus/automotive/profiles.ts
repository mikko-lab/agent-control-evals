import {
  AUTOMOTIVE_CASE_SCHEMA_VERSION,
  AUTOMOTIVE_CORPUS_ENTRY_VERSION,
  AUTOMOTIVE_GENERATOR_VERSION,
  AUTOMOTIVE_ORACLE_VERSION,
  AUTOMOTIVE_PACK_VERSION,
} from "../../spec/automotive/version";

/**
 * Automotive corpus profiles. The smoke profile is registry-driven: one case per
 * declared variant, in declaration order, with no randomness. Changing the
 * registry, a variant or the oracle changes the corpus bytes and its golden SHA.
 */
export const AUTOMOTIVE_SMOKE_PROFILE = {
  id: "auto-smoke-0.1.0",
  variants_per_domain: 6,
  cases: 18,
} as const;

/** Everything that pins the committed automotive smoke corpus besides its SHA-256. */
export const AUTOMOTIVE_SMOKE_CORPUS_IDENTITY = {
  profile: AUTOMOTIVE_SMOKE_PROFILE.id,
  pack_version: AUTOMOTIVE_PACK_VERSION,
  case_schema_version: AUTOMOTIVE_CASE_SCHEMA_VERSION,
  oracle_version: AUTOMOTIVE_ORACLE_VERSION,
  generator_version: AUTOMOTIVE_GENERATOR_VERSION,
  corpus_entry_version: AUTOMOTIVE_CORPUS_ENTRY_VERSION,
} as const;
