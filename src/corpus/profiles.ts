/** Corpus profiles. Changing a seed or count changes the corpus and its golden SHA. */
export const PROFILES = {
  smoke: { seed: "ace-v0.1-smoke", cases: 500 },
  full: { seed: "ace-v0.1-full", cases: 10_000 },
} as const;
export type ProfileName = keyof typeof PROFILES;
