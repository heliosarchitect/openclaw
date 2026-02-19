/**
 * Self-Healing Infrastructure — Type Definitions
 * Cortex v2.2.0
 */

// ──────────────────────────────────────────────────────
// Anomaly Types
// ──────────────────────────────────────────────────────

export type AnomalyType =
  | "process_dead"
  | "process_zombie"
  | "signal_stale"
  | "phantom_position"
  | "pipeline_stuck"
  | "fleet_unreachable"
  | "disk_pressure"
  | "disk_critical"
  | "memory_pressure"
  | "memory_critical"
  | "db_corruption"
  | "log_bloat"
  | "gateway_unresponsive";

export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface HealthAnomaly {
  id: string;
  anomaly_type: AnomalyType;
  target_id: string;
  severity: AnomalySeverity;
  detected_at: string;
  source_id: string;
  details: Record<string, unknown>;
  remediation_hint: string;
  self_resolved?: boolean;
}

// ──────────────────────────────────────────────────────
// Incident Lifecycle
// ──────────────────────────────────────────────────────

export type IncidentState =
  | "detected"
  | "diagnosing"
  | "remediating"
  | "verifying"
  | "resolved"
  | "escalated"
  | "self_resolved"
  | "remediation_failed"
  | "dismissed";

export const TERMINAL_STATES: ReadonlySet<IncidentState> = new Set([
  "resolved",
  "self_resolved",
  "dismissed",
]);

export interface IncidentAuditEntry {
  timestamp: string;
  state: IncidentState;
  actor: "system" | "matthew";
  note: string;
  step_id?: string;
}

export interface Incident {
  id: string;
  anomaly_type: AnomalyType;
  target_id: string;
  severity: AnomalySeverity;
  state: IncidentState;
  runbook_id: string | null;
  detected_at: string;
  state_changed_at: string;
  resolved_at: string | null;
  escalation_tier: number | null;
  escalated_at: string | null;
  dismiss_until: string | null;
  audit_trail: IncidentAuditEntry[];
  details: Record<string, unknown>;
  schema_version: number;
}

// ──────────────────────────────────────────────────────
// Runbook System
// ──────────────────────────────────────────────────────

export type RunbookMode = "dry_run" | "auto_execute";
export type RunbookStepStatus = "pending" | "success" | "failed" | "skipped";

export interface RunbookStepResult {
  step_id: string;
  status: RunbookStepStatus;
  output: string;
  artifacts: string[];
  duration_ms: number;
}

export interface RunbookContext {
  anomaly: HealthAnomaly;
  incident_id: string;
  dry_run: boolean;
}

export interface RunbookStep {
  id: string;
  description: string;
  timeout_ms: number;
  dry_run(): Promise<string>;
  execute(context: RunbookContext): Promise<RunbookStepResult>;
}

export interface Runbook {
  id: string;
  label: string;
  applies_to: AnomalyType[];
  mode: RunbookMode;
  confidence: number;
  dry_run_count: number;
  last_executed_at: string | null;
  last_succeeded_at: string | null;
  auto_approve_whitelist: boolean;
  steps: RunbookStep[];
  created_at: string;
  approved_at: string | null;
  schema_version: number;
}

export interface RunbookDefinition {
  readonly id: string;
  readonly label: string;
  readonly applies_to: AnomalyType[];
  readonly auto_approve_whitelist: boolean;
  build(anomaly: HealthAnomaly): RunbookStep[];
}

export interface RunbookExecutionResult {
  success: boolean;
  mode: RunbookMode;
  steps_executed: RunbookStepResult[];
  verification_passed: boolean | null;
  escalation_needed: boolean;
}

// ──────────────────────────────────────────────────────
// Escalation
// ──────────────────────────────────────────────────────

export type EscalationTier = 0 | 1 | 2 | 3;

export interface EscalationContext {
  action_taken?: string;
  verification_status?: string;
  proposed_steps?: string[];
  failure_reason?: string;
  matthew_decision_needed?: string;
}

// ──────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────

export interface HealingEngineConfig {
  enabled: boolean;
  auto_execute_whitelist: string[];
  tier3_signal_channel: string;
  confidence_auto_execute: number;
  dry_run_graduation_count: number;
  verification_interval_ms: number;
  min_clear_readings: number;
  incident_dismiss_window_ms: number;
  probe_intervals_ms: {
    augur_process: number;
    gateway: number;
    brain_db: number;
    disk: number;
    memory: number;
    log_bloat: number;
  };
  debug: boolean;
}

export const DEFAULT_HEALING_CONFIG: HealingEngineConfig = {
  enabled: true,
  auto_execute_whitelist: ["rb-rotate-logs", "rb-gc-trigger"],
  tier3_signal_channel: "signal",
  confidence_auto_execute: 0.8,
  dry_run_graduation_count: 3,
  verification_interval_ms: 30000,
  min_clear_readings: 3,
  incident_dismiss_window_ms: 86400000,
  probe_intervals_ms: {
    augur_process: 60000,
    gateway: 120000,
    brain_db: 900000,
    disk: 600000,
    memory: 300000,
    log_bloat: 1800000,
  },
  debug: false,
};

// ──────────────────────────────────────────────────────
// Metrics helper type
// ──────────────────────────────────────────────────────

export type MetricsWriter = (
  type: "pipeline",
  data: { task_id: string; stage: string; result: string; duration_ms?: number },
) => Promise<void>;
