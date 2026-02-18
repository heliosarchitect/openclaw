/**
 * Git Activity Adapter — git log across ~/Projects/.
 * Cortex v2.1.0
 */

import { exec } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const execAsync = promisify(exec);
const PROJECTS_DIR = join(homedir(), 'Projects');

// Fallback known repos
const KNOWN_REPOS = [
  'augur-collector', 'augur-trading', 'helios', 'helios-agents',
  'lbf-ham-radio', 'lbf-drone-autonomy', 'brain-db', 'helios-bcdr',
  'lbf-templates',
];

export class GitAdapter implements DataSourceAdapter {
  readonly source_id = 'git.activity';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 600000, freshnessMs = 1200000) {
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
      // Discover repos
      let repoDirs: string[];
      try {
        const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
        repoDirs = entries
          .filter(e => e.isDirectory() && existsSync(join(PROJECTS_DIR, e.name, '.git')))
          .map(e => e.name);
      } catch {
        repoDirs = KNOWN_REPOS.filter(r => existsSync(join(PROJECTS_DIR, r, '.git')));
      }

      const commits: Array<{ repo: string; hash: string; author: string; message: string }> = [];

      const results = await Promise.allSettled(
        repoDirs.map(async repo => {
          const repoPath = join(PROJECTS_DIR, repo);
          const { stdout } = await execAsync(
            `git -C "${repoPath}" log --oneline --all --since='10 minutes ago' --format="%H %an %s"`,
            { timeout: 5000 },
          );
          for (const line of stdout.trim().split('\n').filter(Boolean)) {
            const parts = line.split(' ');
            const hash = parts[0] || '';
            const rest = parts.slice(1).join(' ');
            const authorEnd = rest.indexOf(' ');
            commits.push({
              repo,
              hash,
              author: authorEnd > 0 ? rest.slice(0, authorEnd) : rest,
              message: authorEnd > 0 ? rest.slice(authorEnd + 1) : '',
            });
          }
        }),
      );

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: { commits, repos_scanned: repoDirs.length },
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
