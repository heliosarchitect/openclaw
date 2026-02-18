/**
 * Briefing Generator — Scheduled briefing templates + suppression.
 * Cortex v2.1.0
 */

import type {
  Insight,
  PredictiveIntentConfig,
  SourceReading,
} from './types.js';
import { randomUUID } from 'node:crypto';

export class BriefingGenerator {
  private lastBriefingTime: Map<string, number> = new Map();
  private lastToolCallTime: number = Date.now();

  constructor(
    private getAllReadings: () => SourceReading[],
    private config: PredictiveIntentConfig,
    private sessionId: string = '',
  ) {}

  /**
   * Update session ID (set after session start).
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Record that a tool call happened (for idle detection).
   */
  recordToolCall(): void {
    this.lastToolCallTime = Date.now();
  }

  /**
   * Check and generate morning brief if applicable.
   * Called once at session start.
   */
  checkMorningBrief(): Insight | null {
    const now = new Date();
    const hour = now.getHours();
    if (hour < this.config.briefings.morning_hour_est || hour > 12) return null;

    if (this.isSuppressed('morning')) return null;

    const readings = this.getAllReadings();
    if (readings.length === 0) return null;

    const available = readings.filter(r => r.available);
    const stale = readings.filter(r => {
      if (!r.available) return false;
      return Date.now() - new Date(r.captured_at).getTime() > r.freshness_ms;
    });

    const lines: string[] = [];
    for (const r of available) {
      const age = Math.round((Date.now() - new Date(r.captured_at).getTime()) / 60000);
      lines.push(`• ${r.source_id}: ${age}m ago${stale.some(s => s.source_id === r.source_id) ? ' (STALE)' : ''}`);
    }

    this.lastBriefingTime.set('morning', Date.now());

    return {
      id: randomUUID(),
      type: 'briefing',
      source_id: 'briefing.morning',
      title: 'Good morning — system status',
      body: `${available.length} sources polled, ${stale.length} stale.\n${lines.join('\n')}`,
      urgency: 'low',
      urgency_score: 0.15,
      confidence: 1.0,
      actionable: false,
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      generated_at: new Date().toISOString(),
      state: 'generated',
      delivery_channel: 'preamble',
      delivered_at: null,
      session_id: this.sessionId,
      schema_version: 1,
    };
  }

  /**
   * Check for pre-sleep brief (idle > threshold).
   * Called periodically by a low-frequency timer.
   */
  checkPreSleepBrief(): Insight | null {
    const idleMs = Date.now() - this.lastToolCallTime;
    if (idleMs < this.config.briefings.pre_sleep_idle_ms) return null;
    if (this.isSuppressed('pre_sleep')) return null;

    // Don't generate if no session has been active today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (this.lastToolCallTime < todayStart.getTime()) return null;

    const readings = this.getAllReadings();
    const available = readings.filter(r => r.available);

    const summaryLines: string[] = [];
    for (const r of available) {
      const d = r.data;
      if (r.source_id === 'augur.trades' && d.session_pnl !== undefined) {
        summaryLines.push(`• AUGUR P&L: ${d.session_pnl}`);
      }
      if (r.source_id === 'octoprint.jobs' && d.state === 'Printing') {
        summaryLines.push(`• Print: ${d.progress}% — ETA: ${d.time_left || 'unknown'}`);
      }
      if (r.source_id === 'fleet.health' && (d.unreachable as string[] || []).length > 0) {
        summaryLines.push(`• Fleet: ${(d.unreachable as string[]).length} host(s) down`);
      }
    }

    if (summaryLines.length === 0) {
      summaryLines.push('• All systems nominal');
    }

    this.lastBriefingTime.set('pre_sleep', Date.now());

    return {
      id: randomUUID(),
      type: 'briefing',
      source_id: 'briefing.pre_sleep',
      title: 'End-of-day summary',
      body: summaryLines.join('\n'),
      urgency: 'low',
      urgency_score: 0.1,
      confidence: 1.0,
      actionable: false,
      expires_at: null,
      generated_at: new Date().toISOString(),
      state: 'generated',
      delivery_channel: 'preamble',
      delivered_at: null,
      session_id: this.sessionId,
      schema_version: 1,
    };
  }

  /**
   * Generate a pipeline stage completion brief.
   */
  generatePipelineBrief(taskId: string, stage: string, result: string): Insight {
    return {
      id: randomUUID(),
      type: 'briefing',
      source_id: 'pipeline.state',
      title: `Pipeline: ${taskId} ${result === 'pass' ? 'passed' : 'failed'} ${stage}`,
      body: `Task ${taskId} completed ${stage} stage with result: ${result}.`,
      urgency: result === 'fail' ? 'high' : 'low',
      urgency_score: result === 'fail' ? 0.7 : 0.2,
      confidence: 1.0,
      actionable: result === 'fail',
      expires_at: null,
      generated_at: new Date().toISOString(),
      state: 'generated',
      delivery_channel: result === 'fail' ? 'in_session' : 'preamble',
      delivered_at: null,
      session_id: this.sessionId,
      schema_version: 1,
    };
  }

  private isSuppressed(briefingType: string): boolean {
    const lastTime = this.lastBriefingTime.get(briefingType);
    if (!lastTime) return false;
    return Date.now() - lastTime < this.config.briefings.suppression_window_ms;
  }
}
