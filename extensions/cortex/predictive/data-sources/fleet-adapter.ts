/**
 * Fleet Health Adapter — SSH reachability checks.
 * Cortex v2.1.0
 */

import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const execAsync = promisify(exec);
const FLEET_JSON = join(homedir(), '.openclaw/workspace/fleet.json');

// Hardcoded fallback fleet
const DEFAULT_HOSTS = [
  { name: 'radio', host: '192.168.10.179' },
  { name: 'octoprint', host: '192.168.10.141' },
];

interface FleetHost {
  name: string;
  host: string;
}

export class FleetAdapter implements DataSourceAdapter {
  readonly source_id = 'fleet.health';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private timeoutMs: number;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 300000, freshnessMs = 600000, timeoutMs = 5000) {
    this.poll_interval_ms = pollMs;
    this.freshness_threshold_ms = freshnessMs;
    this.timeoutMs = timeoutMs;
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
      const hosts = await this.loadHosts();
      const timeoutSec = Math.ceil(this.timeoutMs / 1000);

      const results = await Promise.allSettled(
        hosts.map(async h => {
          try {
            await execAsync(
              `ssh -o ConnectTimeout=${timeoutSec} -o BatchMode=yes ${h.host} echo ok`,
              { timeout: this.timeoutMs + 2000 },
            );
            return { name: h.name, host: h.host, reachable: true };
          } catch {
            return { name: h.name, host: h.host, reachable: false };
          }
        }),
      );

      const statuses = results.map(r =>
        r.status === 'fulfilled' ? r.value : { name: 'unknown', host: 'unknown', reachable: false },
      );

      const unreachable = statuses.filter(s => !s.reachable).map(s => `${s.name} (${s.host})`);
      const reachable = statuses.filter(s => s.reachable).map(s => s.name);

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { unreachable, reachable, total: hosts.length },
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

  private async loadHosts(): Promise<FleetHost[]> {
    try {
      if (existsSync(FLEET_JSON)) {
        const raw = await readFile(FLEET_JSON, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.hosts)) return data.hosts;
        if (Array.isArray(data)) return data;
      }
    } catch {
      // Fall through to defaults
    }
    return DEFAULT_HOSTS;
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockData = data;
  }
}
