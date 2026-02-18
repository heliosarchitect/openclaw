/**
 * Urgency Scorer — Stateless scoring: insight + inputs → score + tier + channel.
 * Cortex v2.1.0
 */

import type {
  DeliveryChannel,
  Insight,
  PredictiveIntentConfig,
  ScoredInsight,
  SourceReading,
  UrgencyLevel,
  UrgencyScoringInputs,
} from './types.js';

const URGENCY_ORDER: Record<UrgencyLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Compute time sensitivity from expires_at.
 * Returns 0.0 (no expiry / far future) to 1.0 (about to expire).
 */
export function computeTimeSensitivity(expiresAt: string | null): number {
  if (!expiresAt) return 0.0;
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return 1.0;
  // 15 minutes = fully urgent; 24 hours = not urgent
  const fifteenMin = 15 * 60 * 1000;
  const twentyFourHrs = 24 * 60 * 60 * 1000;
  if (remaining <= fifteenMin) return 1.0;
  if (remaining >= twentyFourHrs) return 0.0;
  return 1.0 - (remaining - fifteenMin) / (twentyFourHrs - fifteenMin);
}

/**
 * Compute cross-source confirmation score.
 * Fraction of other sources that have recent, available readings.
 */
export function computeCrossSourceConfirmation(
  sourceId: string,
  allReadings: SourceReading[],
): number {
  const others = allReadings.filter(r => r.source_id !== sourceId && r.available);
  if (others.length === 0) return 0.0;
  const now = Date.now();
  const fresh = others.filter(r => now - new Date(r.captured_at).getTime() < r.freshness_ms);
  return fresh.length / others.length;
}

/**
 * Assign delivery channel based on urgency tier and focus mode.
 */
export function assignChannel(tier: UrgencyLevel, focusActive: boolean): DeliveryChannel {
  switch (tier) {
    case 'critical':
      return 'signal';
    case 'high':
      return focusActive ? 'synapse' : 'in_session';
    case 'medium':
      return focusActive ? 'preamble' : 'in_session';
    case 'low':
      return 'preamble';
  }
}

/**
 * Score an insight and assign tier + channel.
 */
export function scoreInsight(
  insight: Insight,
  inputs: UrgencyScoringInputs,
  config: PredictiveIntentConfig,
  focusActive: boolean = false,
): ScoredInsight {
  const score =
    inputs.time_sensitivity * 0.40 +
    inputs.financial_impact * 0.30 +
    inputs.historical_action_rate * 0.20 +
    inputs.cross_source_confirmation * 0.10;

  const clampedScore = Math.max(0, Math.min(1, score));

  let tier: UrgencyLevel;
  if (clampedScore >= config.urgency_thresholds.critical) {
    tier = 'critical';
  } else if (clampedScore >= config.urgency_thresholds.high) {
    tier = 'high';
  } else if (clampedScore >= 0.30) {
    tier = 'medium';
  } else {
    tier = 'low';
  }

  const channel = assignChannel(tier, focusActive);

  return {
    insight: {
      ...insight,
      urgency: tier,
      urgency_score: clampedScore,
      delivery_channel: channel,
      state: 'scored',
    },
    score: clampedScore,
    tier,
    channel,
  };
}
