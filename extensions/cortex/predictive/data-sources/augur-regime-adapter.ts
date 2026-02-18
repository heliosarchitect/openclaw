/**
 * AUGUR Regime Adapter — Reads regime.json, detects regime flips.
 * Cortex v2.1.0
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const REGIME_PATH = join(homedir(), 'Projects/augur-trading/regime.json');

export class AugurRegimeAdapter implements DataSourceAdapter {
  readonly source_id = 'augur.regime';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private lastRegime: string | null = null;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 300000, freshnessMs = 600000) {
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
      const raw = await readFile(REGIME_PATH, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const currentRegime = data.regime as string || 'unknown';
      const regimeChanged = this.lastRegime !== null && currentRegime !== this.lastRegime;
      const previousRegime = this.lastRegime;
      this.lastRegime = currentRegime;

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          ...data,
          current_regime: currentRegime,
          previous_regime: previousRegime,
          regime_changed: regimeChanged,
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
