/**
 * AUGUR Trades Adapter — Reads live_trades.db (read-only SQLite).
 * Cortex v2.1.0
 */

import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const execAsync = promisify(exec);
const DB_PATH = join(homedir(), 'Projects/augur-trading/live_trades.db');

export class AugurTradesAdapter implements DataSourceAdapter {
  readonly source_id = 'augur.trades';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
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
      // Read-only mode via URI
      const query = `
        SELECT json_group_array(json_object(
          'id', id, 'symbol', symbol, 'side', side, 'status', status,
          'entry_price', entry_price, 'current_price', current_price,
          'pnl_pct', pnl_pct, 'opened_at', opened_at
        )) as trades
        FROM trades WHERE status='open';
      `;

      const { stdout } = await execAsync(
        `sqlite3 "file:${DB_PATH}?mode=ro" "${query.replace(/\n/g, ' ')}"`,
        { timeout: 10000 },
      );

      const trades = JSON.parse(stdout.trim() || '[]') as Array<Record<string, unknown>>;

      // Compute session stats
      const totalPnl = trades.reduce((sum, t) => sum + ((t.pnl_pct as number) || 0), 0);

      // Count loss streak from recent closed trades
      const streakQuery = `
        SELECT pnl_pct FROM trades WHERE status='closed'
        ORDER BY closed_at DESC LIMIT 10;
      `;
      const { stdout: streakOut } = await execAsync(
        `sqlite3 "file:${DB_PATH}?mode=ro" "${streakQuery.replace(/\n/g, ' ')}"`,
        { timeout: 5000 },
      );
      const closedPnls = streakOut.trim().split('\n').filter(Boolean).map(Number);
      let lossStreak = 0;
      for (const pnl of closedPnls) {
        if (pnl < 0) lossStreak++;
        else break;
      }

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          open_trades: trades,
          session_pnl: `${(totalPnl * 100).toFixed(2)}%`,
          unrealized_pnl_pct: totalPnl,
          loss_streak: lossStreak,
          trade_count: trades.length,
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
