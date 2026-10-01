export const EVALUATION_BOUNDARIES = ["runtime", "component", "N/A"] as const;
export type EvaluationBoundary = (typeof EVALUATION_BOUNDARIES)[number];
export type MeasuredBoundary = Exclude<EvaluationBoundary, "N/A">;
