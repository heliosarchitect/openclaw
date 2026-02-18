/**
 * Cortex Atoms Adapter — Searches atoms via bridge for active context patterns.
 * Cortex v2.1.0
 */

import type { DataSourceAdapter, SourceReading } from '../types.js';

export interface AtomSearchBridge {
  searchAtoms(query: string, limit?: number): Promise<Array<{
    id: string;
    subject: string;
    consequences: string;
    confidence: number;
  }>>;
}

export class CortexAtomsAdapter implements DataSourceAdapter {
  readonly source_id = 'cortex.atoms';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private bridge: AtomSearchBridge | null = null;
  private getHotTopics: (() => string[]) | null = null;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 600000, freshnessMs = 1200000) {
    this.poll_interval_ms = pollMs;
    this.freshness_threshold_ms = freshnessMs;
  }

  configure(bridge: AtomSearchBridge, getHotTopics: () => string[]): void {
    this.bridge = bridge;
    this.getHotTopics = getHotTopics;
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

    if (!this.bridge || !this.getHotTopics) {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {},
        available: false,
        error: 'Atoms bridge not configured',
      };
    }

    try {
      const topics = this.getHotTopics();
      if (topics.length === 0) {
        return {
          source_id: this.source_id,
          captured_at: new Date().toISOString(),
          freshness_ms: this.freshness_threshold_ms,
          data: { relevant_patterns: [] },
          available: true,
        };
      }

      const query = topics.slice(0, 5).join(' ');
      const results = await this.bridge.searchAtoms(query, 5);

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          relevant_patterns: results.map(r => ({
            subject: r.subject,
            consequences: r.consequences,
            confidence: r.confidence,
          })),
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
