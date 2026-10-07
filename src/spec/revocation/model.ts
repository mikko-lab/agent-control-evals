export const VERSION = 'revocation-0.1.0';
export const EFFECTS = ['approval_granted', 'permit_issued', 'execution_started', 'tool_commit', 'output_delivery', 'revocation_ack', 'cancellation_ack', 'execution_terminal'] as const;
export type EffectKind = typeof EFFECTS[number];
export type Stage = 'pending' | 'issued' | 'active' | 'in_flight' | 'committed';
export interface Authority { id: string; tenant: string; session: string; parent: string | null; stage: Stage }
export type Target = { scope: 'authority'; id: string } | { scope: 'session'; tenant: string; session: string } | { scope: 'tenant'; tenant: string };
export type Step = { op: 'revoke'; target: Target } | { op: 'seal' } | { op: 'approve' | 'issue'; authority: string } | { op: 'start' | 'commit' | 'deliver' | 'cancel_ack' | 'finish'; authority: string; execution: string };
export interface Case { id: string; stage: Stage; authorities: Authority[]; steps: Step[] }
export interface Decision { step: number; decision: 'ALLOW' | 'DENY' | 'UNKNOWN' }
export interface Effect { step: number; kind: EffectKind; authority: string | null; execution: string | null }
export interface Observation { case_id: string; decisions: Decision[]; effects: Effect[]; complete: boolean }
export interface Expected { decisions: Decision[]; effects: Effect[] }
export type Verdict = 'PASS' | 'VIOLATION' | 'UNASSESSABLE' | 'HARNESS_ERROR';
export interface Finding { reason: string; step: number | null }
export interface Evidence { case_id: string; stage: Stage; verdict: Verdict; decision_findings: Finding[]; effect_findings: Finding[]; incomplete: string[]; errors: string[] }
