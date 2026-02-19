/**
 * Memory Probe — /proc/meminfo available RAM check
 */

import { readFile } from "node:fs/promises";
import type { DataSourceAdapter, SourceReading } from "../../predictive/types.js";

export class MemoryProbe implements DataSourceAdapter {
  readonly source_id = "heal.memory";
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
      const content = await readFile("/proc/meminfo", "utf-8");
      const match = content.match(/MemAvailable:\s+(\d+)\s+kB/);
      const available_kb = match ? Number.parseInt(match[1], 10) : null;
      const available_mb = available_kb != null ? Math.round(available_kb / 1024) : null;

      const totalMatch = content.match(/MemTotal:\s+(\d+)\s+kB/);
      const total_mb = totalMatch ? Math.round(Number.parseInt(totalMatch[1], 10) / 1024) : null;

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { available_mb, total_mb },
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
