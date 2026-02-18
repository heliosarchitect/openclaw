/**
 * OctoPrint Adapter — REST API + secrets file.
 * API key from ~/.secrets/octoprint.env (not plugin config).
 * Cortex v2.1.0
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DataSourceAdapter, SourceReading } from '../types.js';

export class OctoPrintAdapter implements DataSourceAdapter {
  readonly source_id = 'octoprint.jobs';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private host: string;
  private secretsFile: string;
  private apiKey: string | null = null;
  private prevState: string | null = null;
  private prevMilestone: number = 0;
  private mockData: Record<string, unknown> | null = null;

  constructor(
    host = 'http://192.168.10.141',
    secretsFile = '~/.secrets/octoprint.env',
    pollMs = 300000,
    freshnessMs = 600000,
  ) {
    this.host = host;
    this.secretsFile = secretsFile.replace('~', homedir());
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

    // Load API key if needed
    if (!this.apiKey) {
      this.apiKey = await this.loadApiKey();
      if (!this.apiKey) {
        return {
          source_id: this.source_id,
          captured_at: new Date().toISOString(),
          freshness_ms: this.freshness_threshold_ms,
          data: {},
          available: false,
          error: 'No API key found in secrets file',
        };
      }
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const [jobResp, printerResp] = await Promise.allSettled([
        fetch(`${this.host}/api/job`, {
          headers: { 'X-Api-Key': this.apiKey! },
          signal: controller.signal,
        }),
        fetch(`${this.host}/api/printer`, {
          headers: { 'X-Api-Key': this.apiKey! },
          signal: controller.signal,
        }),
      ]);

      clearTimeout(timeout);

      const jobData = jobResp.status === 'fulfilled' && jobResp.value.ok
        ? await jobResp.value.json() as Record<string, unknown>
        : {};
      const printerData = printerResp.status === 'fulfilled' && printerResp.value.ok
        ? await printerResp.value.json() as Record<string, unknown>
        : {};

      const job = jobData.job as Record<string, unknown> || {};
      const progress = jobData.progress as Record<string, unknown> || {};
      const state = (jobData.state as string) || 'unknown';
      const pct = (progress.completion as number) || 0;
      const timeLeft = progress.printTimeLeft
        ? this.formatTime(progress.printTimeLeft as number)
        : 'unknown';
      const printTime = progress.printTime
        ? this.formatTime(progress.printTime as number)
        : 'unknown';

      const milestone = Math.floor(pct / 25) * 25;

      const result: Record<string, unknown> = {
        state,
        filename: (job.file as Record<string, unknown>)?.name || 'unknown',
        progress: Math.round(pct),
        time_left: timeLeft,
        print_time: printTime,
        prev_state: this.prevState,
        _prev_milestone: this.prevMilestone,
        printer_state: printerData,
      };

      this.prevState = state;
      this.prevMilestone = milestone;

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: result,
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

  private async loadApiKey(): Promise<string | null> {
    try {
      if (!existsSync(this.secretsFile)) return null;
      const content = await readFile(this.secretsFile, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^OCTOPRINT_API_KEY=(.+)$/);
        if (match) return match[1].trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockData = data;
  }
}
