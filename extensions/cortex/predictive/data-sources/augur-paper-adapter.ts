/**
 * AUGUR Paper Adapter — Reads paper_results.db (read-only SQLite).
 * Cortex v2.1.0
 */

import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const execAsync = promisify(exec);
const DB_PATH = join(homedir(), 'Projects/augur-trading/paper_results.db');

export class AugurPaperAdapter implements DataSourceAdapter {
  readonly source_id = 'augur.paper';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 900000, freshnessMs = 1800000) {
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
      const query = `
        SELECT pnl_pct FROM paper_trades
        ORDER BY closed_at DESC LIMIT 10;
      `;
      const { stdout } = await execAsync(
        `sqlite3 "file:${DB_PATH}?mode=ro" "${query.replace(/\n/g, ' ')}"`,
        { timeout: 10000 },
      );

      const pnls = stdout.trim().split('\n').filter(Boolean).map(Number);
      let lossStreak = 0;
      for (const pnl of pnls) {
        if (pnl < 0) lossStreak++;
        else break;
      }

      const wins = pnls.filter(p => p > 0).length;
      const winRate = pnls.length > 0 ? `${((wins / pnls.length) * 100).toFixed(0)}%` : 'N/A';

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          loss_streak: lossStreak,
          win_rate: winRate,
          recent_trades: pnls.length,
          total_pnl_pct: pnls.reduce((s, p) => s + p, 0),
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
