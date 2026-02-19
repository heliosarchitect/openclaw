/**
 * Log Bloat Probe — Find log files > 100MB
 */

import { exec } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { DataSourceAdapter, SourceReading } from "../../predictive/types.js";

const execAsync = promisify(exec);

const LOG_DIRS = ["/var/log", "~/.openclaw/logs", "~/.pm2/logs", "~/Projects/augur/logs"];

export class LogBloatProbe implements DataSourceAdapter {
  readonly source_id = "heal.log_bloat";
  readonly freshness_threshold_ms: number;
  private mockData: Record<string, unknown> | null = null;

  constructor(readonly poll_interval_ms: number) {
    this.freshness_threshold_ms = poll_interval_ms * 2;
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
      const home = homedir();
      const dirs = LOG_DIRS.map((d) => d.replace("~", home)).join(" ");
      const { stdout } = await execAsync(
        `find ${dirs} -name "*.log" -size +100M -type f 2>/dev/null || true`,
        { timeout: 10000 },
      );

      const bloated_files = stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { bloated_files, count: bloated_files.length },
        available: true,
      };
    } catch (err) {
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { bloated_files: [] },
        available: true,
      };
    }
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockData = data;
  }
}
