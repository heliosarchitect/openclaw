/**
 * Healing Probe Registry — Supplemental health probes
 * Cortex v2.2.0
 */

import type { DataSourceAdapter, SourceReading } from "../predictive/types.js";
import type { HealingEngineConfig } from "./types.js";
import { AugurProcessProbe } from "./probes/augur-process-probe.js";
import { BrainDbProbe } from "./probes/brain-db-probe.js";
import { DiskProbe } from "./probes/disk-probe.js";
import { GatewayProbe } from "./probes/gateway-probe.js";
import { LogBloatProbe } from "./probes/log-bloat-probe.js";
import { MemoryProbe } from "./probes/memory-probe.js";

export type ReadingCallback = (reading: SourceReading) => Promise<void>;

export class HealingProbeRegistry {
  private probes: Map<string, DataSourceAdapter> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;
  private onReading: ReadingCallback | null = null;

  constructor(config: HealingEngineConfig, dbPath?: string) {
    const intervals = config.probe_intervals_ms;

    this.registerProbe(new AugurProcessProbe(intervals.augur_process));
    this.registerProbe(new GatewayProbe(intervals.gateway));
    this.registerProbe(new BrainDbProbe(intervals.brain_db, dbPath));
    this.registerProbe(new DiskProbe(intervals.disk));
    this.registerProbe(new MemoryProbe(intervals.memory));
    this.registerProbe(new LogBloatProbe(intervals.log_bloat));
  }

  private registerProbe(probe: DataSourceAdapter): void {
    this.probes.set(probe.source_id, probe);
  }

  getProbe(sourceId: string): DataSourceAdapter | undefined {
    return this.probes.get(sourceId);
  }

  setReadingCallback(cb: ReadingCallback): void {
    this.onReading = cb;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    for (const probe of this.probes.values()) {
      if (probe.poll_interval_ms <= 0) continue;
      this.schedulePoll(probe);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedulePoll(probe: DataSourceAdapter): void {
    const run = async () => {
      if (!this.running) return;
      try {
        const reading = await probe.poll();
        if (this.onReading) {
          await this.onReading(reading);
        }
      } catch (err) {
        console.warn(`[Heal] Probe ${probe.source_id} error:`, err);
      }
      if (this.running) {
        this.timers.set(probe.source_id, setTimeout(run, probe.poll_interval_ms));
      }
    };

    // Delay first poll to avoid thundering herd at startup
    const jitter = Math.floor(Math.random() * 5000);
    this.timers.set(probe.source_id, setTimeout(run, jitter));
  }

  get probeCount(): number {
    return this.probes.size;
  }
}
