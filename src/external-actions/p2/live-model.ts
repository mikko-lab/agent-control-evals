import { createHash } from 'node:crypto';
import { canonicalJson } from '../../util/canonical-json';
import type { GuardMode } from './routes';
export const roles = ['e', 'x', 'r', 'p', 'q'] as const;
export type Role = typeof roles[number];
export const ips: Record<Role, string> = { e: '10.88.0.2', x: '10.88.0.30', r: '10.88.0.53', p: '10.88.0.10', q: '10.88.0.20' };
export const uids: Record<Role, number> = { e: 32001, x: 32002, r: 32003, p: 32004, q: 32005 };
export const H = 32006;
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export interface Identity { run: string; case: string; attempt: 'a1' }
export interface Event extends Identity { service: Role; seq: number; prev: string; hash: string; kind: string; data: Record<string, unknown> }
export const eventHash = (e: Omit<Event, 'hash'> | Event) => { const { hash: _, ...rest } = e as Event; return digest(canonicalJson(rest)); };
export interface ProcessResult { role: Role; code: number | null; signal: string | null; timed_out: boolean }
export interface LiveCase extends Identity {
  decision: 'ALLOW' | 'DENY' | 'UNKNOWN';
  events: Record<Role, Event[]>;
  states: Record<string, { records: string[]; open: number; active: number }>;
  processes: ProcessResult[];
  isolation: { before: string; after: string; before_hash: string; after_hash: string; probes: Record<string, boolean>; channels_before: boolean; channels_after: boolean };
  errors: string[];
}
export interface LiveRun { format: 'external-action-p2-live-run/1'; evidence_kind: 'local_recipient_observation'; run_id: string; guard: GuardMode; node: string; platform: string; cases: LiveCase[] }
export interface ServiceConfig extends Identity { role: Role; directory: string; proposal: { url: string; final_url?: string; body: string }; answers: Record<string, string | null>; guard: GuardMode; inject?: string }
