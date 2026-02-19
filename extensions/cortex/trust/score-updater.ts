/**
 * EWMA Score Updater — Trust score updates via exponentially weighted moving average
 * Earned Autonomy Phase 5.6
 */

import type { Outcome, RiskTier, TrustConfig } from "./types.js";
import { DEFAULT_TRUST_CONFIG, OUTCOME_VALUES } from "./types.js";

/**
 * Compute new trust score after an outcome using EWMA.
 * Score is always clamped to [0.0, 1.0].
 */
export function updateScore(
  currentScore: number,
  outcome: Outcome,
  tier: RiskTier,
  config: TrustConfig = DEFAULT_TRUST_CONFIG,
): number {
  if (outcome === "pending") return currentScore;

  const alpha = config.ewma_alphas[tier] ?? 0.1;
  if (alpha === 0) return currentScore; // Tier 4: no updates

  const rawValue = OUTCOME_VALUES[outcome] ?? 0.0;

  // Normalize value from [-1, +1] to [0, 1] for EWMA
  const normalized = (rawValue + 1.0) / 2.0;

  const newScore = alpha * normalized + (1 - alpha) * currentScore;
  return Math.max(0.0, Math.min(1.0, newScore));
}

export const ScoreUpdater = { updateScore };
