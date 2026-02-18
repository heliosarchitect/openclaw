/**
 * Delivery Router — Channel routing, batching, dedup, focus-mode check.
 * Cortex v2.1.0
 */

import type {
  DeliveryChannel,
  Insight,
  PredictBridgeMethods,
  PredictiveIntentConfig,
} from './types.js';
import { focusModeTracker } from './focus-mode-tracker.js';

export class DeliveryRouter {
  private batchBuffer: Insight[] = [];
  private lastSignalTime: Map<string, number> = new Map();
  private lastDelivered: Map<string, string> = new Map(); // source+type → ISO timestamp

  constructor(
    private bridge: PredictBridgeMethods,
    private config: PredictiveIntentConfig,
    private sendSignalFn?: (text: string) => Promise<void>,
    private sendSynapseFn?: (text: string) => Promise<void>,
  ) {}

  /**
   * Route an insight to its delivery channel.
   */
  async route(insight: Insight): Promise<void> {
    const channel = insight.delivery_channel;
    if (!channel) return;

    // Focus mode override: defer medium/low to batch
    if (focusModeTracker.isFocusModeActive() && (channel === 'in_session' || channel === 'preamble')) {
      this.batchBuffer.push(insight);
      return;
    }

    switch (channel) {
      case 'signal':
        await this.deliverSignal(insight);
        break;
      case 'synapse':
        await this.deliverSynapse(insight);
        break;
      case 'in_session':
        // In-session delivery is pulled by the hook system, not pushed
        // Mark as delivered and update state
        await this.markDelivered(insight);
        break;
      case 'preamble':
        this.batchBuffer.push(insight);
        break;
    }
  }

  /**
   * Flush batched low/medium insights. Called at session preamble or focus-mode exit.
   */
  async flushBatch(): Promise<Insight[]> {
    if (this.batchBuffer.length === 0) return [];
    const batch = [...this.batchBuffer];
    this.batchBuffer = [];

    for (const insight of batch) {
      await this.markDelivered(insight);
    }

    return batch;
  }

  /**
   * Get pending in-session insights (for hook injection).
   */
  getInSessionInsights(): Insight[] {
    // Return insights that are scored/queued for in_session delivery
    return [];  // Managed by PollingEngine's insight queue
  }

  /**
   * Format insight for display.
   */
  static formatInsight(insight: Insight): string {
    return `[PREDICTIVE ${insight.urgency.toUpperCase()}] ${insight.title}\n${insight.body}\nSource: ${insight.source_id} | Confidence: ${(insight.confidence * 100).toFixed(0)}% | Expires: ${insight.expires_at ?? 'none'}`;
  }

  /**
   * Format a batch of insights for preamble injection.
   */
  static formatBatch(insights: Insight[]): string {
    if (insights.length === 0) return '';
    const header = `\n── Predictive Insights (${insights.length}) ──\n`;
    const body = insights
      .map(i => `⚡ [${i.urgency.toUpperCase()}] ${i.title}\n  ${i.body}`)
      .join('\n\n');
    return header + body;
  }

  private async deliverSignal(insight: Insight): Promise<void> {
    // Rate limit: max 1 signal per 5 min per source
    const key = insight.source_id;
    const lastTime = this.lastSignalTime.get(key) || 0;
    const minInterval = Math.max(30000, 5 * 60 * 1000); // Hard minimum 30s

    if (Date.now() - lastTime < minInterval) {
      // Downgrade to in_session
      insight.delivery_channel = 'in_session';
      await this.markDelivered(insight);
      return;
    }

    if (this.sendSignalFn) {
      try {
        await this.sendSignalFn(DeliveryRouter.formatInsight(insight));
        this.lastSignalTime.set(key, Date.now());
      } catch (err) {
        console.warn('DeliveryRouter: signal send failed:', err);
      }
    }

    await this.markDelivered(insight);
  }

  private async deliverSynapse(insight: Insight): Promise<void> {
    if (this.sendSynapseFn) {
      try {
        await this.sendSynapseFn(DeliveryRouter.formatInsight(insight));
      } catch (err) {
        console.warn('DeliveryRouter: synapse send failed:', err);
      }
    }
    await this.markDelivered(insight);
  }

  private async markDelivered(insight: Insight): Promise<void> {
    const now = new Date().toISOString();
    insight.state = 'delivered';
    insight.delivered_at = now;
    this.lastDelivered.set(`${insight.source_id}::${insight.type}`, now);

    try {
      await this.bridge.updateInsightState(insight.id, 'delivered', {
        delivered_at: now,
        delivery_channel: insight.delivery_channel,
      });
    } catch (err) {
      console.warn('DeliveryRouter: failed to persist delivery state:', err);
    }
  }

  get batchSize(): number {
    return this.batchBuffer.length;
  }
}
