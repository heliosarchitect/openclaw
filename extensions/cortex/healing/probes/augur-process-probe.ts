/**
 * AUGUR Process Probe — PID + process table check, zombie detection
 */

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DataSourceAdapter, SourceReading } from "../../predictive/types.js";

const execAsync = promisify(exec);

export class AugurProcessProbe implements DataSourceAdapter {
  readonly source_id = "heal.augur_process";
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
      // Check for AUGUR process via ps
      const { stdout } = await execAsync('ps aux | grep -i "[a]ugur.*executor" || true', {
        timeout: 5000,
      });
      const lines = stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const pidFound = lines.length > 0;

      // Check for zombie
      let zombie = false;
      if (pidFound) {
        const { stdout: statOut } = await execAsync(
          `ps aux | grep -i "[a]ugur.*executor" | awk '{print $8}' || true`,
          { timeout: 3000 },
        );
        zombie = statOut.includes("Z");
      }

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { pid_found: pidFound, zombie, process_count: lines.length },
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
