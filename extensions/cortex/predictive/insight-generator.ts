/**
 * Insight Generator — Raw reading → typed Insight conversion, per-source logic.
 * Handlers are pure functions: reading + config → Insight[].
 * Cortex v2.1.0
 */

import { randomUUID } from 'node:crypto';
import type {
  Insight,
  InsightHandler,
  InsightType,
  PredictiveIntentConfig,
  SourceReading,
} from './types.js';

/**
 * Check if a duplicate insight of same source+type exists within the dedup window.
 */
function isDuplicate(
  sourceId: string,
  type: InsightType,
  existing: Insight[],
  duplicateWindowMs: number,
): boolean {
  const now = Date.now();
  return existing.some(
    i =>
      i.source_id === sourceId &&
      i.type === type &&
      i.state !== 'expired' &&
      i.state !== 'superseded' &&
      now - new Date(i.generated_at).getTime() < duplicateWindowMs,
  );
}

function makeInsight(
  type: InsightType,
  sourceId: string,
  title: string,
  body: string,
  sessionId: string,
  opts?: { confidence?: number; actionable?: boolean; expiresAt?: string | null },
): Insight {
  return {
    id: randomUUID(),
    type,
    source_id: sourceId,
    title: title.slice(0, 80),
    body: body.slice(0, 500),
    urgency: 'low',      // Will be set by scorer
    urgency_score: 0,
    confidence: opts?.confidence ?? 0.8,
    actionable: opts?.actionable ?? true,
    expires_at: opts?.expiresAt ?? null,
    generated_at: new Date().toISOString(),
    state: 'generated',
    delivery_channel: null,
    delivered_at: null,
    session_id: sessionId,
    schema_version: 1,
  };
}

// ──────────────────────────────────────────────────────
// Per-source handlers
// ──────────────────────────────────────────────────────

const augurSignalsHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const insights: Insight[] = [];
  const d = reading.data;

  // Stale signal detection
  if (d.stale === true) {
    if (!isDuplicate(reading.source_id, 'anomaly', existing, dupWindow)) {
      insights.push(makeInsight(
        'anomaly', reading.source_id,
        'AUGUR signal data is stale',
        `Signal file hasn't updated in ${Math.round((d.staleness_ms as number || 0) / 60000)} minutes. Collector may be down.`,
        d._session_id as string || '',
        { confidence: 0.9, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
      ));
    }
  }

  // New signal
  if (d.signal && d.signal !== 'none' && d.signal !== d._prev_signal) {
    if (!isDuplicate(reading.source_id, 'opportunity', existing, dupWindow)) {
      insights.push(makeInsight(
        'opportunity', reading.source_id,
        `AUGUR signal: ${d.signal as string}`,
        `New signal generated: ${d.signal as string}. Symbol: ${d.symbol as string || 'unknown'}. Strength: ${d.strength as string || 'unknown'}.`,
        d._session_id as string || '',
        { confidence: (d.confidence as number) ?? 0.7, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() },
      ));
    }
  }

  return insights;
};

const augurTradesHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const insights: Insight[] = [];
  const d = reading.data;

  // Loss streak
  const lossStreak = d.loss_streak as number || 0;
  if (lossStreak >= config.anomaly_thresholds.augur_loss_streak) {
    if (!isDuplicate(reading.source_id, 'anomaly', existing, dupWindow)) {
      insights.push(makeInsight(
        'anomaly', reading.source_id,
        `AUGUR: ${lossStreak} consecutive losses`,
        `Loss streak of ${lossStreak} trades. Session P&L: ${d.session_pnl as string || 'unknown'}. Consider reviewing strategy.`,
        d._session_id as string || '',
        { confidence: 0.9 },
      ));
    }
  }

  // Open trade update
  if (d.open_trades && (d.open_trades as unknown[]).length > 0) {
    const pnlPct = d.unrealized_pnl_pct as number || 0;
    if (Math.abs(pnlPct) >= config.anomaly_thresholds.augur_pnl_loss_pct) {
      if (!isDuplicate(reading.source_id, 'alert', existing, dupWindow)) {
        const direction = pnlPct > 0 ? 'profit' : 'loss';
        insights.push(makeInsight(
          'alert', reading.source_id,
          `AUGUR open trade: ${(pnlPct * 100).toFixed(1)}% ${direction}`,
          `Open trades with ${(pnlPct * 100).toFixed(1)}% unrealized ${direction}. Count: ${(d.open_trades as unknown[]).length}.`,
          d._session_id as string || '',
          { confidence: 0.85, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
        ));
      }
    }
  }

  return insights;
};

const augurRegimeHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;

  if (d.regime_changed === true) {
    if (!isDuplicate(reading.source_id, 'anomaly', existing, dupWindow)) {
      return [makeInsight(
        'anomaly', reading.source_id,
        `Market regime changed: ${d.previous_regime as string} → ${d.current_regime as string}`,
        `Regime flip detected. Previous: ${d.previous_regime as string}. Current: ${d.current_regime as string}. This may affect active signals.`,
        d._session_id as string || '',
        { confidence: 0.85 },
      )];
    }
  }
  return [];
};

const augurPaperHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;

  const lossStreak = d.loss_streak as number || 0;
  if (lossStreak >= config.anomaly_thresholds.augur_loss_streak) {
    if (!isDuplicate(reading.source_id, 'anomaly', existing, dupWindow)) {
      return [makeInsight(
        'anomaly', reading.source_id,
        `AUGUR paper: ${lossStreak} consecutive losses`,
        `Paper trading loss streak of ${lossStreak}. Win rate: ${d.win_rate as string || 'unknown'}. Consider strategy review.`,
        d._session_id as string || '',
        { confidence: 0.7 },
      )];
    }
  }
  return [];
};

const gitActivityHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;
  const commits = d.commits as Array<{ repo: string; hash: string; author: string; message: string }> || [];

  if (commits.length === 0) return [];

  if (!isDuplicate(reading.source_id, 'briefing', existing, dupWindow)) {
    const repoSummary = new Map<string, number>();
    for (const c of commits) {
      repoSummary.set(c.repo, (repoSummary.get(c.repo) || 0) + 1);
    }
    const summary = Array.from(repoSummary.entries())
      .map(([repo, count]) => `${repo}: ${count}`)
      .join(', ');

    return [makeInsight(
      'briefing', reading.source_id,
      `Git activity: ${commits.length} new commits`,
      `Recent commits across repos: ${summary}. Latest: "${commits[0]?.message || ''}"`,
      d._session_id as string || '',
      { confidence: 1.0, actionable: false },
    )];
  }
  return [];
};

const fleetHealthHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;
  const unreachable = d.unreachable as string[] || [];

  if (unreachable.length === 0) return [];

  if (!isDuplicate(reading.source_id, 'alert', existing, dupWindow)) {
    return [makeInsight(
      'alert', reading.source_id,
      `Fleet: ${unreachable.length} host(s) unreachable`,
      `Unreachable hosts: ${unreachable.join(', ')}. SSH timeout: ${config.anomaly_thresholds.fleet_ssh_timeout_ms}ms.`,
      d._session_id as string || '',
      { confidence: 0.9, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() },
    )];
  }
  return [];
};

const octoprintHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;

  const insights: Insight[] = [];

  // Print complete
  if (d.state === 'Operational' && d.progress === 100 && d.prev_state === 'Printing') {
    if (!isDuplicate(reading.source_id, 'alert', existing, dupWindow)) {
      insights.push(makeInsight(
        'alert', reading.source_id,
        'Print job complete',
        `Print finished: ${d.filename as string || 'unknown'}. Time: ${d.print_time as string || 'unknown'}.`,
        d._session_id as string || '',
        { confidence: 1.0 },
      ));
    }
  }

  // Print error
  if (d.state === 'Error' || d.state === 'Offline') {
    if (!isDuplicate(reading.source_id, 'anomaly', existing, dupWindow)) {
      insights.push(makeInsight(
        'anomaly', reading.source_id,
        `OctoPrint: ${d.state as string}`,
        `Printer state: ${d.state as string}. ${d.error as string || 'Check printer connection.'}`,
        d._session_id as string || '',
        { confidence: 0.95 },
      ));
    }
  }

  // Progress milestone (every 25%)
  if (d.state === 'Printing' && typeof d.progress === 'number') {
    const pct = d.progress as number;
    const milestone = Math.floor(pct / 25) * 25;
    if (milestone > 0 && milestone !== d._prev_milestone) {
      if (!isDuplicate(reading.source_id, 'briefing', existing, dupWindow / 4)) {
        insights.push(makeInsight(
          'briefing', reading.source_id,
          `Print ${milestone}% complete`,
          `Printing: ${d.filename as string || 'unknown'} — ${pct.toFixed(0)}%. ETA: ${d.time_left as string || 'unknown'}.`,
          d._session_id as string || '',
          { confidence: 1.0, actionable: false },
        ));
      }
    }
  }

  return insights;
};

const pipelineStateHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;
  const insights: Insight[] = [];

  // Stuck stage
  if (d.stuck_task) {
    if (!isDuplicate(reading.source_id, 'anomaly', existing, dupWindow)) {
      insights.push(makeInsight(
        'anomaly', reading.source_id,
        `Pipeline stuck: ${d.stuck_task as string}`,
        `Task ${d.stuck_task as string} has been in ${d.stuck_stage as string} for ${Math.round((d.stuck_duration_ms as number || 0) / 60000)} minutes. May need manual intervention.`,
        d._session_id as string || '',
        { confidence: 0.8 },
      ));
    }
  }

  // Failed stage
  if (d.failed_task) {
    if (!isDuplicate(reading.source_id, 'alert', existing, dupWindow)) {
      insights.push(makeInsight(
        'alert', reading.source_id,
        `Pipeline failed: ${d.failed_task as string}`,
        `Task ${d.failed_task as string} failed at ${d.failed_stage as string}. Result: ${d.failed_result as string || 'fail'}.`,
        d._session_id as string || '',
        { confidence: 0.95 },
      ));
    }
  }

  // Stage completion
  if (d.completed_task && d.completed_stage) {
    if (!isDuplicate(reading.source_id, 'briefing', existing, dupWindow)) {
      insights.push(makeInsight(
        'briefing', reading.source_id,
        `Pipeline: ${d.completed_task as string} passed ${d.completed_stage as string}`,
        `Task ${d.completed_task as string} completed ${d.completed_stage as string} stage successfully.`,
        d._session_id as string || '',
        { confidence: 1.0, actionable: false },
      ));
    }
  }

  return insights;
};

const cortexSessionHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const d = reading.data;

  // Session handler is real-time, primarily provides context for other handlers
  // Generate reminder insights for stale pending tasks
  const pendingTasks = d.pending_tasks as string[] || [];
  if (pendingTasks.length > 0) {
    const dupWindow = config.delivery.duplicate_window_ms;
    if (!isDuplicate(reading.source_id, 'reminder', existing, dupWindow)) {
      return [makeInsight(
        'reminder', reading.source_id,
        `${pendingTasks.length} pending task(s) from prior session`,
        `Carried over: ${pendingTasks.slice(0, 3).join('; ')}${pendingTasks.length > 3 ? ` (+${pendingTasks.length - 3} more)` : ''}`,
        d._session_id as string || '',
        { confidence: 0.7, actionable: true },
      )];
    }
  }
  return [];
};

const cortexAtomsHandler: InsightHandler = (reading, config, existing) => {
  if (!reading.available) return [];
  const dupWindow = config.delivery.duplicate_window_ms;
  const d = reading.data;
  const patterns = d.relevant_patterns as Array<{ subject: string; consequences: string; confidence: number }> || [];

  if (patterns.length === 0) return [];

  if (!isDuplicate(reading.source_id, 'pattern', existing, dupWindow)) {
    const top = patterns[0];
    return [makeInsight(
      'pattern', reading.source_id,
      `Pattern: ${(top?.subject || 'unknown').slice(0, 60)}`,
      `Relevant causal pattern: ${top?.subject || ''} → ${top?.consequences || ''}. Confidence: ${((top?.confidence || 0) * 100).toFixed(0)}%.`,
      d._session_id as string || '',
      { confidence: top?.confidence ?? 0.5, actionable: false },
    )];
  }
  return [];
};

// ──────────────────────────────────────────────────────
// InsightGenerator class
// ──────────────────────────────────────────────────────

export class InsightGenerator {
  private handlers: Map<string, InsightHandler> = new Map();

  constructor() {
    this.handlers.set('augur.signals', augurSignalsHandler);
    this.handlers.set('augur.trades', augurTradesHandler);
    this.handlers.set('augur.regime', augurRegimeHandler);
    this.handlers.set('augur.paper', augurPaperHandler);
    this.handlers.set('git.activity', gitActivityHandler);
    this.handlers.set('fleet.health', fleetHealthHandler);
    this.handlers.set('octoprint.jobs', octoprintHandler);
    this.handlers.set('pipeline.state', pipelineStateHandler);
    this.handlers.set('cortex.session', cortexSessionHandler);
    this.handlers.set('cortex.atoms', cortexAtomsHandler);
  }

  generate(reading: SourceReading, config: PredictiveIntentConfig, existingInsights: Insight[]): Insight[] {
    const handler = this.handlers.get(reading.source_id);
    if (!handler) return [];
    try {
      return handler(reading, config, existingInsights);
    } catch (err) {
      console.warn(`InsightGenerator: handler error for ${reading.source_id}:`, err);
      return [];
    }
  }

  registerHandler(sourceId: string, handler: InsightHandler): void {
    this.handlers.set(sourceId, handler);
  }
}
