/**
 * Pattern Learner — Cross-session correlation → atom creation.
 * Cortex v2.1.0
 */

import type {
  InsightFeedback,
  PredictBridgeMethods,
  PredictiveIntentConfig,
} from './types.js';

export interface AtomCreateFn {
  (params: {
    subject: string;
    action: string;
    outcome: string;
    consequences: string;
    confidence: number;
    source: string;
  }): Promise<string>;
}

export interface AtomSearchFn {
  (field: string, query: string): Promise<Array<{ id: string; confidence: number }>>;
}

export class PatternLearner {
  constructor(
    private bridge: PredictBridgeMethods,
    private config: PredictiveIntentConfig,
    private atomCreate?: AtomCreateFn,
    private atomSearch?: AtomSearchFn,
  ) {}

  /**
   * Analyze a feedback record for patterns. Called after each acted_on=true feedback write.
   */
  async analyzeForPattern(feedback: InsightFeedback): Promise<void> {
    if (!feedback.acted_on) return;
    if (!this.atomCreate) return;

    try {
      // Get feedback history for this source+type
      const history = await this.bridge.getFeedbackHistory(
        feedback.source_id,
        feedback.insight_type,
        true, // acted_on only
        30,   // 30-day window
      );

      if (history.length < 3) return; // Minimum observations

      // Check if atom already exists
      if (this.atomSearch) {
        const existing = await this.atomSearch(
          'consequences',
          `${feedback.source_id} ${feedback.insight_type}`,
        );
        if (existing.length > 0) return; // Already tracked
      }

      // Get action rate
      const rate = await this.bridge.getActionRate(feedback.source_id, feedback.insight_type);
      if (rate.action_rate < 0.3) return; // Not confident enough

      // Create atom
      await this.atomCreate({
        subject: feedback.source_id,
        action: `generates ${feedback.insight_type} insight`,
        outcome: `Matthew acts on it ${(rate.action_rate * 100).toFixed(0)}% of the time`,
        consequences: `subsequent ${feedback.source_id} insights should be scored with action_rate=${rate.action_rate.toFixed(2)}`,
        confidence: rate.action_rate,
        source: 'predictive-intent',
      });
    } catch (err) {
      console.warn('PatternLearner: analysis failed:', err);
    }
  }
}
