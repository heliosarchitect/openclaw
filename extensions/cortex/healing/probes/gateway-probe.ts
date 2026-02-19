/**
 * Gateway Probe — OpenClaw gateway self-probe with consecutive failure counting
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { DataSourceAdapter, SourceReading } from "../../predictive/types.js";

const execAsync = promisify(exec);

export class GatewayProbe implements DataSourceAdapter {
  readonly source_id = "heal.gateway";
  readonly freshness_threshold_ms: number;
  private consecutiveFailures = 0;
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
      const { stdout } = await execAsync("openclaw gateway status 2>&1 || true", {
        timeout: 10000,
      });
      const ok = stdout.toLowerCase().includes("running") || stdout.toLowerCase().includes("ok");

      if (ok) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
      }

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          ok,
          consecutive_failures: this.consecutiveFailures,
          raw: stdout.trim().slice(0, 200),
        },
        available: true,
      };
    } catch (err) {
      this.consecutiveFailures++;
      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { ok: false, consecutive_failures: this.consecutiveFailures },
        available: true,
      };
    }
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockData = data;
  }
}
