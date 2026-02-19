/**
 * Earned Autonomy — Progressive Trust — Type Definitions
 * Cortex v2.5.0 / Phase 5.6
 */

// ──────────────────────────────────────────────────────
// Risk Classification
// ──────────────────────────────────────────────────────

export type RiskTier = 1 | 2 | 3 | 4;

export interface Classification {
  tier: RiskTier;
  category: string;
}

export interface ClassificationRule {
  tool: string | RegExp;
  action?: RegExp;
  pattern?: RegExp;
  path?: RegExp;
  tier: RiskTier;
  category: string;
}

// ──────────────────────────────────────────────────────
// Gate Decisions
// ──────────────────────────────────────────────────────

export type GateResult = "pass" | "pause" | "block";

export interface GateDecision {
  result: GateResult;
  reason: string;
  tier: RiskTier;
  category: string;
  trust_score: number;
  threshold: number;
  decision_id: string;
  override_active: boolean;
}

// ──────────────────────────────────────────────────────
// Decision Log
// ──────────────────────────────────────────────────────

export type Outcome =
  | "pass"
  | "corrected_minor"
  | "corrected_significant"
  | "tool_error_helios"
  | "tool_error_external"
  | "denied_by_matthew"
  | "pending";

export type OutcomeSource =
  | "feedback_window_expired"
  | "correction_detected"
  | "tool_failure"
  | "matthew_denied"
  | null;

export interface DecisionRecord {
  decision_id: string;
  timestamp: string;
  session_id: string;
  tool_name: string;
  tool_params_hash: string;
  tool_params_summary: string;
  risk_tier: RiskTier;
  category: string;
  gate_decision: GateResult;
  trust_score_at_decision: number;
  override_active: boolean;
  outcome: Outcome;
  outcome_source: OutcomeSource;
  outcome_resolved_at: string | null;
  correction_message: string | null;
}

// ──────────────────────────────────────────────────────
// Trust Scores
// ──────────────────────────────────────────────────────

export interface TrustScore {
  score_id: string;
  category: string;
  risk_tier: RiskTier;
  current_score: number;
  ewma_alpha: number;
  decision_count: number;
  decisions_last_30d: number;
  last_updated: string;
  initial_score: number;
}

// ──────────────────────────────────────────────────────
// Trust Overrides
// ──────────────────────────────────────────────────────

export type OverrideType = "granted" | "revoked";

export interface TrustOverride {
  override_id: string;
  category: string;
  override_type: OverrideType;
  reason: string;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  active: boolean;
}

// ──────────────────────────────────────────────────────
// Milestones
// ──────────────────────────────────────────────────────

export type MilestoneType =
  | "first_auto_approve"
  | "tier_promotion"
  | "tier_demotion"
  | "blocked"
  | "override_granted"
  | "override_revoked";

export interface TrustMilestone {
  milestone_id: string;
  timestamp: string;
  category: string;
  milestone_type: MilestoneType;
  old_score: number | null;
  new_score: number;
  trigger: string;
  synapse_notified: boolean;
}

// ──────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────

export interface TrustConfig {
  tier_thresholds: Record<number, number>;
  tier_floors: Record<number, number>;
  ewma_alphas: Record<number, number>;
  initial_scores: Record<number, number>;
  feedback_window_ms: Record<number, number>;
  confirmation_ttl_ms: number;
  /** H2 mitigation: correction window in minutes (default 30). Only decisions within this
   *  window are eligible for recordCorrection(). Prevents old pending decisions from being
   *  retroactively corrected by unrelated conversational messages. */
  correction_window_minutes: number;
}

export const DEFAULT_TRUST_CONFIG: TrustConfig = {
  tier_thresholds: { 1: 0.5, 2: 0.7, 3: 0.85, 4: Infinity },
  tier_floors: { 1: 0.2, 2: 0.4, 3: 0.6, 4: Infinity },
  ewma_alphas: { 1: 0.08, 2: 0.1, 3: 0.15, 4: 0.0 },
  initial_scores: { 1: 0.75, 2: 0.65, 3: 0.55, 4: 0.0 },
  feedback_window_ms: {
    1: 30 * 60 * 1000,
    2: 30 * 60 * 1000,
    3: 60 * 60 * 1000,
    4: 60 * 60 * 1000,
  },
  confirmation_ttl_ms: 10 * 60 * 1000,
  correction_window_minutes: 30, // H2: only corrections within 30 min of a decision count
};

// ──────────────────────────────────────────────────────
// Outcome Values for EWMA
// ──────────────────────────────────────────────────────

export const OUTCOME_VALUES: Record<string, number> = {
  pass: +1.0,
  corrected_minor: -0.5,
  corrected_significant: -1.0,
  tool_error_helios: -0.3,
  tool_error_external: 0.0,
  denied_by_matthew: -0.2,
};

// ──────────────────────────────────────────────────────
// Known Categories
// ──────────────────────────────────────────────────────

export const KNOWN_CATEGORIES: Array<{ category: string; tier: RiskTier }> = [
  // Tier 1
  { category: "read_file", tier: 1 },
  { category: "exec_status", tier: 1 },
  { category: "cortex_query", tier: 1 },
  { category: "web_search", tier: 1 },
  { category: "synapse_read", tier: 1 },
  // Tier 2
  { category: "write_file", tier: 2 },
  { category: "cortex_write", tier: 2 },
  { category: "synapse_send", tier: 2 },
  { category: "cron_create", tier: 2 },
  { category: "session_spawn", tier: 2 },
  // Tier 3
  { category: "service_restart", tier: 3 },
  { category: "config_change", tier: 3 },
  { category: "gateway_action", tier: 3 },
  { category: "cron_modify", tier: 3 },
  { category: "deploy", tier: 3 },
  // Tier 4
  { category: "financial_augur", tier: 4 },
  { category: "financial_crypto", tier: 4 },
  { category: "financial_stripe", tier: 4 },
];
