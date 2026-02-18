/**
 * Feedback Tracker — Action detection, rate updates, brain.db writes.
 * Cortex v2.1.0
 */

import { randomUUID } from 'node:crypto';
import type {
  FeedbackActionType,
  Insight,
  InsightFeedback,
  InsightType,
  PredictBridgeMethods,
  PredictiveIntentConfig,
} from './types.js';

// Keywords per source for implicit action detection
const SOURCE_KEYWORDS: Record<string, string[]> = {
  'augur.signals': ['augur', 'signal', 'trade', 'trading', 'position'],
  'augur.trades': ['augur', 'trade', 'pnl', 'profit', 'loss', 'position'],
  'augur.regime': ['regime', 'market', 'augur'],
  'augur.paper': ['paper', 'backtest', 'augur'],
  'fleet.health': ['ssh', 'fleet', 'host', 'server', 'reachable', 'unreachable'],
  'octoprint.jobs': ['print', 'printer', 'octoprint', '3d', 'filament'],
  'pipeline.state': ['pipeline', 'stage', 'task', 'build', 'verify', 'deploy'],
  'git.activity': ['git', 'commit', 'push', 'branch', 'merge'],
  'cortex.session': ['session', 'context', 'memory'],
  'cortex.atoms': ['atom', 'pattern', 'causal'],
};

// Acknowledgment phrases for explicit detection
const ACK_PHRASES = /\b(ok|got it|done|noted|acknowledged|thanks|will do|on it|roger|copy)\b/i;

export class FeedbackTracker {
  private deliveryTimestamps: Map<string, number> = new Map(); // insight_id → delivery time

  constructor(
    private bridge: PredictBridgeMethods,
    private config: PredictiveIntentConfig,
  ) {}

  /**
   * Register that an insight was delivered (call after delivery).
   */
  onInsightDelivered(insight: Insight): void {
    this.deliveryTimestamps.set(insight.id, Date.now());
  }

  /**
   * Check if a tool call implicitly acts on a delivered insight.
   * Called from after_tool_call hook.
   */
  async checkImplicitAction(
    toolName: string,
    toolArgs: Record<string, unknown>,
    deliveredInsights: Insight[],
    sessionId: string,
  ): Promise<void> {
    const now = Date.now();
    const actionWindow = this.config.feedback.action_window_ms;
    const argStr = JSON.stringify(toolArgs).toLowerCase();

    for (const insight of deliveredInsights) {
      const deliveryTime = this.deliveryTimestamps.get(insight.id);
      if (!deliveryTime || now - deliveryTime > actionWindow) continue;
      if (insight.state === 'acted_on') continue;

      const keywords = SOURCE_KEYWORDS[insight.source_id] || [];
      const matched = keywords.some(kw => argStr.includes(kw));

      if (matched) {
        await this.recordFeedback(insight, 'implicit', now - deliveryTime, sessionId);
      }
    }
  }

  /**
   * Check if an assistant message explicitly acknowledges a delivered insight.
   * Called from agent_end hook.
   */
  async checkExplicitAction(
    messageText: string,
    deliveredInsights: Insight[],
    sessionId: string,
  ): Promise<void> {
    if (!ACK_PHRASES.test(messageText)) return;

    const now = Date.now();
    const actionWindow = this.config.feedback.action_window_ms;

    for (const insight of deliveredInsights) {
      const deliveryTime = this.deliveryTimestamps.get(insight.id);
      if (!deliveryTime || now - deliveryTime > actionWindow) continue;
      if (insight.state === 'acted_on') continue;

      await this.recordFeedback(insight, 'explicit', now - deliveryTime, sessionId);
    }
  }

  /**
   * Mark all insights in action window as ignored if still unacted.
   * Called periodically (e.g., every 10 minutes).
   */
  async expireUnacted(deliveredInsights: Insight[], sessionId: string): Promise<void> {
    const now = Date.now();
    const actionWindow = this.config.feedback.action_window_ms;

    for (const insight of deliveredInsights) {
      const deliveryTime = this.deliveryTimestamps.get(insight.id);
      if (!deliveryTime) continue;
      if (now - deliveryTime <= actionWindow) continue;
      if (insight.state !== 'delivered') continue;

      await this.recordFeedback(insight, 'ignored', null, sessionId);
    }
  }

  private async recordFeedback(
    insight: Insight,
    actionType: FeedbackActionType,
    latencyMs: number | null,
    sessionId: string,
  ): Promise<void> {
    const actedOn = actionType !== 'ignored';

    const feedback: InsightFeedback = {
      id: randomUUID(),
      insight_id: insight.id,
      insight_type: insight.type,
      source_id: insight.source_id,
      urgency_at_delivery: insight.urgency,
      delivered_at: insight.delivered_at || new Date().toISOString(),
      channel: insight.delivery_channel || 'in_session',
      acted_on: actedOn,
      action_type: actionType,
      latency_ms: latencyMs,
      session_id: sessionId,
      created_at: new Date().toISOString(),
    };

    try {
      await this.bridge.saveFeedback(feedback);

      // Update insight state
      const newState = actedOn ? 'acted_on' : 'ignored';
      insight.state = newState;
      await this.bridge.updateInsightState(insight.id, newState);

      // Update action rate
      await this.updateActionRate(insight.source_id, insight.type, actedOn);

      // Clean up delivery timestamp
      this.deliveryTimestamps.delete(insight.id);
    } catch (err) {
      console.warn('FeedbackTracker: failed to record feedback:', err);
    }
  }

  private async updateActionRate(
    sourceId: string,
    insightType: InsightType,
    actedOn: boolean,
  ): Promise<void> {
    try {
      const current = await this.bridge.getActionRate(sourceId, insightType);
      const delta = actedOn
        ? this.config.feedback.rate_increase_per_act
        : -this.config.feedback.rate_decrease_per_ignore;
      const newRate = Math.max(0, Math.min(1, current.action_rate + delta));
      const newCount = current.observation_count + 1;

      const rateHalved = (
        newCount >= this.config.feedback.min_observations &&
        newRate < this.config.feedback.low_value_threshold
      );

      await this.bridge.upsertActionRate(sourceId, insightType, newRate, newCount, rateHalved);
    } catch (err) {
      console.warn('FeedbackTracker: failed to update action rate:', err);
    }
  }
}
