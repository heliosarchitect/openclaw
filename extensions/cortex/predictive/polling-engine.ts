/**
 * Polling Engine — Multi-source async timer loop orchestration.
 * Cortex v2.1.0
 */

import type {
  DataSourceAdapter,
  Insight,
  PredictBridgeMethods,
  PredictiveIntentConfig,
  SourceReading,
  UrgencyScoringInputs,
} from './types.js';
import { InsightGenerator } from './insight-generator.js';
import { computeCrossSourceConfirmation, computeTimeSensitivity, scoreInsight } from './urgency-scorer.js';
import { focusModeTracker } from './focus-mode-tracker.js';

export class PollingEngine {
  private adapters: Map<string, DataSourceAdapter> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private lastReadings: Map<string, SourceReading> = new Map();
  private insightQueue: Map<string, Insight> = new Map();
  private running: boolean = false;
  private insightGenerator: InsightGenerator;
  private lastPollTime: string | null = null;

  constructor(
    private bridge: PredictBridgeMethods,
    private config: PredictiveIntentConfig,
  ) {
    this.insightGenerator = new InsightGenerator();
  }

  /**
   * Register a data source adapter.
   */
  registerAdapter(adapter: DataSourceAdapter): void {
    this.adapters.set(adapter.source_id, adapter);
  }

  /**
   * Start all polling loops. Recover queued insights from brain.db.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Recover queued insights from prior session
    try {
      const queued = await this.bridge.getQueuedInsights();
      for (const insight of queued) {
        this.insightQueue.set(insight.id, insight);
      }
    } catch (err) {
      console.warn('PollingEngine: failed to recover queued insights:', err);
    }

    // Start per-source timers
    for (const adapter of this.adapters.values()) {
      if (adapter.poll_interval_ms <= 0) continue; // On-demand only (e.g., cortex.session)
      this.schedulePoll(adapter);
    }
  }

  /**
   * Stop all polling loops.
   */
  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /**
   * Get the last reading for a source.
   */
  getLastReading(sourceId: string): SourceReading | null {
    return this.lastReadings.get(sourceId) || null;
  }

  /**
   * Get all latest readings.
   */
  getAllReadings(): SourceReading[] {
    return Array.from(this.lastReadings.values());
  }

  /**
   * Get insights relevant to a set of context keywords. For pre-action hook injection.
   */
  getRelevantInsights(keywords: string[]): Insight[] {
    if (keywords.length === 0) return [];
    const lowerKeywords = keywords.map(k => k.toLowerCase());
    return Array.from(this.insightQueue.values())
      .filter(i =>
        i.state === 'scored' || i.state === 'queued' || i.state === 'delivered'
      )
      .filter(i => {
        const text = `${i.title} ${i.body} ${i.source_id}`.toLowerCase();
        return lowerKeywords.some(kw => text.includes(kw));
      })
      .sort((a, b) => b.urgency_score - a.urgency_score)
      .slice(0, 3);
  }

  /**
   * Query insights (for cortex_predict tool).
   */
  queryInsights(params: {
    query?: string;
    sources?: string[];
    urgency_min?: string;
    include_queue?: boolean;
    limit?: number;
  }): {
    insights: Insight[];
    sources_polled: number;
    sources_stale: string[];
    last_poll: string | null;
  } {
    const urgencyOrder: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    let results = Array.from(this.insightQueue.values());

    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.body.toLowerCase().includes(q) ||
        i.source_id.includes(q),
      );
    }
    if (params.sources?.length) {
      results = results.filter(i => params.sources!.includes(i.source_id));
    }
    if (params.urgency_min) {
      const minLevel = urgencyOrder[params.urgency_min] ?? 0;
      results = results.filter(i => (urgencyOrder[i.urgency] ?? 0) >= minLevel);
    }
    if (!params.include_queue) {
      results = results.filter(i => i.state === 'delivered');
    }

    results = results
      .sort((a, b) => b.urgency_score - a.urgency_score)
      .slice(0, params.limit ?? 5);

    const stale = Array.from(this.lastReadings.values())
      .filter(r => Date.now() - new Date(r.captured_at).getTime() > r.freshness_ms)
      .map(r => r.source_id);

    return {
      insights: results,
      sources_polled: this.adapters.size,
      sources_stale: stale,
      last_poll: this.lastPollTime,
    };
  }

  /**
   * Get all queued/delivered insights (for feedback tracking).
   */
  getDeliveredInsights(): Insight[] {
    return Array.from(this.insightQueue.values())
      .filter(i => i.state === 'delivered');
  }

  /**
   * On-demand poll for a specific source (e.g., cortex.session).
   */
  async pollSource(sourceId: string): Promise<SourceReading | null> {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) return null;
    try {
      const reading = await adapter.poll();
      await this.onReadingComplete(reading);
      return reading;
    } catch (err) {
      console.warn(`PollingEngine: on-demand poll failed for ${sourceId}:`, err);
      return null;
    }
  }

  private schedulePoll(adapter: DataSourceAdapter): void {
    if (!this.running) return;

    const run = async () => {
      try {
        const reading = await adapter.poll();
        await this.onReadingComplete(reading);
      } catch (err) {
        console.warn(`PollingEngine: poll error for ${adapter.source_id}:`, err);
      }
      if (this.running) {
        const timer = setTimeout(run, adapter.poll_interval_ms);
        this.timers.set(adapter.source_id, timer);
      }
    };

    // Start first poll immediately
    const timer = setTimeout(run, 0);
    this.timers.set(adapter.source_id, timer);
  }

  private async onReadingComplete(reading: SourceReading): Promise<void> {
    this.lastReadings.set(reading.source_id, reading);
    this.lastPollTime = new Date().toISOString();

    if (!reading.available) return;

    // Generate insights
    const existing = Array.from(this.insightQueue.values());
    const newInsights = this.insightGenerator.generate(reading, this.config, existing);

    // Score each insight
    for (const insight of newInsights) {
      try {
        const rate = await this.bridge.getActionRate(insight.source_id, insight.type);
        const inputs: UrgencyScoringInputs = {
          time_sensitivity: computeTimeSensitivity(insight.expires_at),
          financial_impact: this.estimateFinancialImpact(insight),
          historical_action_rate: rate.action_rate,
          cross_source_confirmation: computeCrossSourceConfirmation(
            insight.source_id,
            this.getAllReadings(),
          ),
        };

        const scored = scoreInsight(
          insight,
          inputs,
          this.config,
          focusModeTracker.isFocusModeActive(),
        );

        // Update queue
        scored.insight.state = 'queued';
        this.insightQueue.set(scored.insight.id, scored.insight);

        // Persist to brain.db
        await this.bridge.saveInsight(scored.insight);
      } catch (err) {
        console.warn(`PollingEngine: scoring/persist failed for insight:`, err);
      }
    }

    // Expire old insights
    await this.expireOldInsights();
  }

  private estimateFinancialImpact(insight: Insight): number {
    // Financial sources get higher impact scores
    if (insight.source_id.startsWith('augur.')) {
      if (insight.type === 'anomaly' || insight.type === 'alert') return 0.7;
      if (insight.type === 'opportunity') return 0.9;
      return 0.3;
    }
    return 0.0;
  }

  private async expireOldInsights(): Promise<void> {
    const now = Date.now();
    for (const [id, insight] of this.insightQueue) {
      if (insight.expires_at && new Date(insight.expires_at).getTime() < now) {
        insight.state = 'expired';
        this.insightQueue.delete(id);
        try {
          await this.bridge.updateInsightState(id, 'expired');
        } catch {
          // Best effort
        }
      }
    }
  }

  get adapterCount(): number {
    return this.adapters.size;
  }

  get queueSize(): number {
    return this.insightQueue.size;
  }
}
