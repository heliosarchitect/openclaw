/**
 * AUGUR Signals Adapter — Reads live_signal.json.
 * Cortex v2.1.0
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const SIGNAL_PATH = join(homedir(), 'Projects/augur-trading/live_signal.json');

export class AugurSignalsAdapter implements DataSourceAdapter {
  readonly source_id = 'augur.signals';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private prevSignal: string | null = null;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 60000, freshnessMs = 120000) {
    this.poll_interval_ms = pollMs;
    this.freshness_threshold_ms = freshnessMs;
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

    try {
      const raw = await readFile(SIGNAL_PATH, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Check staleness
      const updatedAt = data.updated_at as string | undefined;
      let stale = false;
      let stalenessMs = 0;
      if (updatedAt) {
        stalenessMs = Date.now() - new Date(updatedAt).getTime();
        stale = stalenessMs > this.freshness_threshold_ms;
      }

      const result: Record<string, unknown> = {
        ...data,
        stale,
        staleness_ms: stalenessMs,
        _prev_signal: this.prevSignal,
      };

      // Strip sensitive fields
      for (const key of Object.keys(result)) {
        if (/key|token|password|secret/i.test(key)) {
          delete result[key];
        }
      }

      this.prevSignal = (data.signal as string) || null;

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: result,
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
