/**
 * P1b run record (`external-action-run-record/1`): what the harness itself observed about one case run, beside the
 * observation the evaluator reads. Clock readings are microseconds on CLOCK_MONOTONIC.
 */
import type { Recipient } from '../spec/model';

export const RUN_RECORD_FORMAT = 'external-action-run-record/1';
export interface FileMode { owner: string; group: string; mode: string }
export interface ProbeResult { name: string; target: string; blocked: boolean; detail: string }
export interface AttemptTimeline {
  id: string;
  issued_us: number | null;
  answer: null | { decision: string; status: number | null; at_us: number };
  timeout_at_us: number | null;
  recorded_decision: string | null;
  late_answers: { decision: string; status: number | null; at_us: number }[];
  cancel_sent_us: number | null;
}
export interface WindowTimeline { fence_id: string; attempts: string[]; status: 'closed' | 'failed'; failure_reason: string | null; closed_at_us: number | null; signal_sent_us: number | null }
export interface RunRecord {
  format: typeof RUN_RECORD_FORMAT;
  run_id: string;
  case_id: string;
  guard: { id: string; sha256: string };
  timeline: {
    start_fence_us: number | null;
    attempts: AttemptTimeline[];
    windows: WindowTimeline[];
    t_q_start_us: number | null;
    executor_quiescent_us: number | null;
    t_r_start_us: number | null;
    recipient_quiescent_us: number | null;
    final_fence_us: number | null;
    cleanup_us: number | null;
  };
  guard_events: { event: string; attempt: string | null; detail: unknown; at_us: number }[];
  executor_processes: { name: string; code: number | null; signal: string | null; at_us: number; killed_by_cleanup: boolean }[];
  protocol_errors: string[];
  isolation: {
    probes: { ns: string; results: ProbeResult[] }[];
    config_before_sha256: string;
    config_after_sha256: string | null;
    config_before: string;
    config_after: string | null;
    drop_counters_before: Record<string, number>;
    drop_counters_after: Record<string, number> | null;
    canary_hits: { kind: string; peer: string; mono_us: number }[];
    netem: { dev: string; delay_us: number | null }[];
    channel: {
      journal_dir: FileMode; ctl_dir: FileMode;
      journal_files: (FileMode & { recipient: Recipient })[];
      ctl_sockets: (FileMode & { recipient: Recipient })[];
      /** The doubles' uid and the harness reader's gid. */
      expected: { owner: string; group: string };
    };
  };
  errors: { code: string; message: string }[];
}
