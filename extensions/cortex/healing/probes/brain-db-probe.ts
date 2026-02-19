/**
 * Brain DB Probe — SQLite integrity check
 */

import { exec } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DataSourceAdapter, SourceReading } from "../../predictive/types.js";

const execAsync = promisify(exec);

export class BrainDbProbe implements DataSourceAdapter {
  readonly source_id = "heal.brain_db";
  readonly freshness_threshold_ms: number;
  private dbPath: string;
  private mockData: Record<string, unknown> | null = null;

  constructor(
    readonly poll_interval_ms: number,
    dbPath?: string,
  ) {
    this.freshness_threshold_ms = poll_interval_ms * 2;
    this.dbPath = dbPath ?? join(homedir(), ".openclaw", "workspace", "memory", "brain.db");
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
      const { stdout } = await execAsync(
        `sqlite3 "${this.dbPath}" "PRAGMA integrity_check;" 2>&1`,
        { timeout: 30000 },
      );
      const integrity_ok = stdout.trim().toLowerCase() === "ok";

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { integrity_ok, raw: stdout.trim().slice(0, 500) },
        available: true,
      };
    } catch (err) {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { integrity_ok: false, error: String(err) },
        available: true,
      };
    }
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockData = data;
  }
}
