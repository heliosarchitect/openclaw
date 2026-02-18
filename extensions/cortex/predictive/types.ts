/**
 * Predictive Intent — Type Definitions
 * Cortex v2.1.0
 */

// ──────────────────────────────────────────────────────
// Insight Record — core data unit of the prediction engine
// ──────────────────────────────────────────────────────

export type InsightType =
  | 'anomaly'
  | 'opportunity'
  | 'briefing'
  | 'reminder'
  | 'alert'
  | 'pattern';

export type UrgencyLevel = 'low' | 'medium' | 'high' | 'critical';

export type InsightState =
  | 'generated'
  | 'scored'
  | 'queued'
  | 'delivered'
  | 'acted_on'
  | 'ignored'
  | 'superseded'
  | 'expired';

export type DeliveryChannel =
  | 'preamble'
  | 'in_session'
  | 'synapse'
  | 'signal';

export interface Insight {
  id: string;
  type: InsightType;
  source_id: string;
  title: string;               // ≤80 chars
  body: string;                // ≤500 chars
  urgency: UrgencyLevel;
  urgency_score: number;       // 0.0–1.0
  confidence: number;          // 0.0–1.0
  actionable: boolean;
  expires_at: string | null;   // ISO 8601
  generated_at: string;        // ISO 8601
  state: InsightState;
  delivery_channel: DeliveryChannel | null;
  delivered_at: string | null;
  session_id: string;
  schema_version: number;
}

// ──────────────────────────────────────────────────────
// Feedback Record — what Matthew did with the insight
// ──────────────────────────────────────────────────────

export type FeedbackActionType = 'explicit' | 'implicit' | 'ignored';

export interface InsightFeedback {
  id: string;
  insight_id: string;
  insight_type: InsightType;
  source_id: string;
  urgency_at_delivery: UrgencyLevel;
  delivered_at: string;
  channel: DeliveryChannel;
  acted_on: boolean;
  action_type: FeedbackActionType;
  latency_ms: number | null;
  session_id: string;
  created_at: string;
}

// ──────────────────────────────────────────────────────
// Data Source Adapter interface
// ──────────────────────────────────────────────────────

export interface SourceReading {
  source_id: string;
  captured_at: string;         // ISO 8601
  freshness_ms: number;        // Staleness threshold for this source
  data: Record<string, unknown>;
  available: boolean;          // false = source unavailable this cycle
  error?: string;
}

export interface DataSourceAdapter {
  readonly source_id: string;
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  poll(): Promise<SourceReading>;
  setMockData?(data: Record<string, unknown>): void;
}

// ──────────────────────────────────────────────────────
// Urgency scoring inputs
// ──────────────────────────────────────────────────────

export interface UrgencyScoringInputs {
  time_sensitivity: number;          // 0.0–1.0 based on expires_at
  financial_impact: number;          // 0.0–1.0
  historical_action_rate: number;    // 0.0–1.0 from predict_action_rates
  cross_source_confirmation: number; // 0.0–1.0 fraction of confirming sources
}

export interface ScoredInsight {
  insight: Insight;
  score: number;
  tier: UrgencyLevel;
  channel: DeliveryChannel;
}

// ──────────────────────────────────────────────────────
// Action Rate record (from predict_action_rates table)
// ──────────────────────────────────────────────────────

export interface ActionRate {
  id: string;
  source_id: string;
  insight_type: string;
  action_rate: number;
  observation_count: number;
  rate_halved: boolean;
  last_updated: string;
}

// ──────────────────────────────────────────────────────
// Predictive Intent Config Block
// ──────────────────────────────────────────────────────

export interface PredictiveIntentConfig {
  enabled: boolean;
  poll_intervals_ms: Record<string, number>;
  staleness_thresholds_ms: Record<string, number>;
  urgency_thresholds: {
    high: number;
    critical: number;
  };
  delivery: {
    signal_channel: string;
    focus_detection_window_ms: number;
    focus_detection_min_calls: number;
    batch_window_ms: number;
    duplicate_window_ms: number;
  };
  anomaly_thresholds: {
    augur_signal_stale_ms: number;
    augur_loss_streak: number;
    augur_pnl_loss_pct: number;
    fleet_ssh_timeout_ms: number;
    pipeline_stuck_ms: number;
  };
  feedback: {
    action_window_ms: number;
    rate_increase_per_act: number;
    rate_decrease_per_ignore: number;
    min_observations: number;
    low_value_threshold: number;
  };
  briefings: {
    morning_hour_est: number;
    pre_sleep_idle_ms: number;
    suppression_window_ms: number;
  };
  octoprint: {
    host: string;
    secrets_file: string;
  };
  debug: boolean;
}

// ──────────────────────────────────────────────────────
// Insight handler type for InsightGenerator
// ──────────────────────────────────────────────────────

export type InsightHandler = (
  reading: SourceReading,
  config: PredictiveIntentConfig,
  existingInsights: Insight[],
) => Insight[];

// ──────────────────────────────────────────────────────
// Bridge methods interface for predict module
// ──────────────────────────────────────────────────────

export interface PredictBridgeMethods {
  saveInsight(insight: Insight): Promise<void>;
  updateInsightState(insightId: string, state: InsightState, extra?: Record<string, unknown>): Promise<void>;
  getQueuedInsights(): Promise<Insight[]>;
  saveFeedback(feedback: InsightFeedback): Promise<void>;
  getActionRate(sourceId: string, insightType: string): Promise<ActionRate>;
  upsertActionRate(sourceId: string, insightType: string, rate: number, count: number, halved: boolean): Promise<void>;
  getFeedbackHistory(sourceId: string, insightType: string, actedOn: boolean, windowDays: number): Promise<InsightFeedback[]>;
  getRecentDelivered(limit?: number): Promise<Insight[]>;
  expireStaleInsights(): Promise<number>;
}
