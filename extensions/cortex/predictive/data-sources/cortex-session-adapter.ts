/**
 * Cortex Session Adapter — Reads SessionState in-process (on-demand, no timer).
 * Cortex v2.1.0
 */

import type { DataSourceAdapter, SourceReading } from '../types.js';

export interface SessionStateReader {
  getHotTopics(): string[];
  getActiveProjects(): string[];
  getPendingTasks(): string[];
}

export class CortexSessionAdapter implements DataSourceAdapter {
  readonly source_id = 'cortex.session';
  readonly poll_interval_ms = 0; // On-demand only
  readonly freshness_threshold_ms: number;
  private reader: SessionStateReader | null = null;
  private mockData: Record<string, unknown> | null = null;

  constructor(freshnessMs = 30000) {
    this.freshness_threshold_ms = freshnessMs;
  }

  setReader(reader: SessionStateReader): void {
    this.reader = reader;
  }

  async poll(): Promise<SourceReading> {
    if (this.mockData) {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: this.mockData,
        available: true,
      };
    }

    if (!this.reader) {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {},
        available: false,
        error: 'No session state reader configured',
      };
    }

    try {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          hot_topics: this.reader.getHotTopics(),
          active_projects: this.reader.getActiveProjects(),
          pending_tasks: this.reader.getPendingTasks(),
        },
        available: true,
      };
    } catch (err) {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {},
        available: false,
        error: String(err),
      };
    }
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockData = data;
  }
}
