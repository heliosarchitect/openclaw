/**
 * Disk Probe — Usage threshold checks on / and ~/
 */

import { exec } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { DataSourceAdapter, SourceReading } from "../../predictive/types.js";

const execAsync = promisify(exec);

export class DiskProbe implements DataSourceAdapter {
  readonly source_id = "heal.disk";
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
      const { stdout } = await execAsync(
        `df --output=target,pcent / "${home}" 2>/dev/null | tail -n +2`,
        { timeout: 5000 },
      );

      const mounts: Array<{ mount: string; usage_pct: number }> = [];
      const seen = new Set<string>();

      for (const line of stdout.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const mount = parts[0];
        if (seen.has(mount)) continue;
        seen.add(mount);
        const pctStr = parts[1].replace("%", "");
        const usage_pct = Number.parseInt(pctStr, 10) / 100;
        if (!Number.isNaN(usage_pct)) {
          mounts.push({ mount, usage_pct });
        }
      }

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { mounts },
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
