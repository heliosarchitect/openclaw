/**
 * Real-Time Learning — Type Definitions
 * Cortex v2.6.0 (task-011)
 *
 * Reactive event pipeline: detect failures → classify root cause → propagate fixes.
 */

// ──────────────────────────────────────────────────────
// Failure Event Types
// ──────────────────────────────────────────────────────

export type FailureType = "TOOL_ERR" | "CORRECT" | "SOP_VIOL" | "TRUST_DEM" | "PIPE_FAIL";
export type FailureTier = 1 | 2 | 3;

export type PropagationStatus =
  | "pending"
  | "in_progress"
  | "propagated"
  | "escalated"
  | "no_fix_needed";

export interface FailureEvent {
  id: string;
  detected_at: string;
  type: FailureType;
  tier: FailureTier;
  source: string;
  context: Record<string, unknown>;
  raw_input?: string;
  failure_desc: string;
  root_cause?: string;
  propagation_status: PropagationStatus;
  recurrence_count: number;
  last_recurred_at?: string;
}

// ──────────────────────────────────────────────────────
// Propagation Records
// ──────────────────────────────────────────────────────

export type PropagationType =
  | "sop_patch"
  | "hook_update"
  | "atom_update"
  | "regression_test"
  | "synapse_relay"
  | "cross_system";

export type PropagationRecordStatus =
  | "pending"
  | "committed"
  | "previewed"
  | "approved"
  | "rejected"
  | "failed";

export interface PropagationRecord {
  id: string;
  failure_id: string;
  started_at: string;
  completed_at?: string;
  propagation_type: PropagationType;
  target_file?: string;
  commit_sha?: string;
  synapse_msg_id?: string;
  preview_sent_at?: string;
  matthew_approved?: boolean | null;
  status: PropagationRecordStatus;
  diff_preview?: string;
  error_detail?: string;
}

// ──────────────────────────────────────────────────────
// Regression Tests
// ──────────────────────────────────────────────────────

export interface RegressionTest {
  id: string;
  failure_id: string;
  created_at: string;
  last_run_at?: string;
  description: string;
  test_file?: string;
  pass_count: number;
  fail_count: number;
  last_result?: "pass" | "fail" | "skip";
  active: boolean;
}

// ──────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────

export type PropagationTarget =
  | "sop_patch"
  | "hook_pattern"
  | "atom"
  | "regression_test"
  | "synapse_relay"
  | "cross_system";

export interface ClassificationResult {
  root_cause: string;
  propagation_targets: PropagationTarget[];
}

export interface ClassificationRule {
  type: FailureType | "*";
  rootCausePattern?: RegExp;
  rootCauseLabel: string;
  propagationTargets: PropagationTarget[];
}

// ──────────────────────────────────────────────────────
// Detection Events (internal queue items)
// ──────────────────────────────────────────────────────

export interface DetectionPayload {
  type: FailureType;
  tier: FailureTier;
  source: string;
  context: Record<string, unknown>;
  raw_input?: string;
  failure_desc: string;
}

// ──────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────

export interface RealtimeLearningConfig {
  enabled: boolean;
  correction_keywords: string[];
  correction_scan_window_ms: number;
  correction_proximity_threshold: number;
  recurrence_window_days: number;
  preview_ttl_minutes: number;
  tier3_default_on_timeout: "skip" | "commit";
  sop_auto_commit_types: string[];
  weekly_metrics_day: string;
  weekly_metrics_hour: number;
  sop_directory: string;
  debug: boolean;
}

export const DEFAULT_REALTIME_LEARNING_CONFIG: RealtimeLearningConfig = {
  enabled: true,
  correction_keywords: [
    "wrong path",
    "that's wrong",
    "bad command",
    "use X instead",
    "outdated SOP",
    "stale SOP",
    "that hook is wrong",
    "wrong binary",
    "incorrect",
    "no that's not right",
    "should be",
    "use this instead",
    "stop doing that",
    "that's broken",
  ],
  correction_scan_window_ms: 300000,
  correction_proximity_threshold: 0.3,
  recurrence_window_days: 30,
  preview_ttl_minutes: 10,
  tier3_default_on_timeout: "skip",
  sop_auto_commit_types: ["additive"],
  weekly_metrics_day: "monday",
  weekly_metrics_hour: 9,
  sop_directory: "",
  debug: false,
};

// ──────────────────────────────────────────────────────
// Dependencies (injected)
// ──────────────────────────────────────────────────────

export interface RealtimeLearningDB {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface RealtimeLearningDeps {
  db: RealtimeLearningDB;
  sendSynapse: (
    subject: string,
    body: string,
    priority: "info" | "action" | "urgent",
    threadId?: string,
  ) => Promise<string | undefined>;
  writeMetric: (
    type: "pipeline",
    data: { task_id: string; stage: string; result: string; duration_ms?: number },
  ) => Promise<void>;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  repoRoot: string;
}

// ──────────────────────────────────────────────────────
// Metrics
// ──────────────────────────────────────────────────────

export interface LearningMetrics {
  avg_t2p_seconds: number | null;
  propagation_completeness_pct: number | null;
  recurrence_rate_pct: number | null;
  total_failures: number;
  total_propagations: number;
  failures_by_type: Record<FailureType, number>;
}
