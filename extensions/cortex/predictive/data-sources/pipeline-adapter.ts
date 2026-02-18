/**
 * Pipeline Adapter — Reads pipeline state.json, detects stuck/failed stages.
 * Cortex v2.1.0
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DataSourceAdapter, SourceReading } from '../types.js';

const STATE_PATH = join(homedir(), 'Projects/helios/extensions/cortex/pipeline/state.json');

interface PipelineTask {
  task_id: string;
  current_stage: string;
  stage_started_at: string;
  result?: string;
}

export class PipelineAdapter implements DataSourceAdapter {
  readonly source_id = 'pipeline.state';
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms: number;
  private prevState: Record<string, PipelineTask> = {};
  private stuckThresholdMs: number;
  private mockData: Record<string, unknown> | null = null;

  constructor(pollMs = 120000, freshnessMs = 240000, stuckThresholdMs = 3600000) {
    this.poll_interval_ms = pollMs;
    this.freshness_threshold_ms = freshnessMs;
    this.stuckThresholdMs = stuckThresholdMs;
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
      if (!existsSync(STATE_PATH)) {
        return {
          source_id: this.source_id,
          captured_at: new Date().toISOString(),
          freshness_ms: this.freshness_threshold_ms,
          data: {},
          available: false,
          error: 'state.json not found',
        };
      }

      const raw = await readFile(STATE_PATH, 'utf-8');
      const state = JSON.parse(raw) as Record<string, unknown>;
      const tasks = (state.tasks || []) as PipelineTask[];
      const now = Date.now();

      let stuckTask: string | null = null;
      let stuckStage: string | null = null;
      let stuckDurationMs = 0;
      let failedTask: string | null = null;
      let failedStage: string | null = null;
      let failedResult: string | null = null;
      let completedTask: string | null = null;
      let completedStage: string | null = null;

      for (const task of tasks) {
        // Stuck detection
        if (task.stage_started_at) {
          const duration = now - new Date(task.stage_started_at).getTime();
          if (duration > this.stuckThresholdMs && task.result !== 'fail' && task.result !== 'pass') {
            stuckTask = task.task_id;
            stuckStage = task.current_stage;
            stuckDurationMs = duration;
          }
        }

        // Failed detection
        if (task.result === 'fail') {
          failedTask = task.task_id;
          failedStage = task.current_stage;
          failedResult = 'fail';
        }

        // Completion detection (compare with previous state)
        const prev = this.prevState[task.task_id];
        if (prev && prev.current_stage !== task.current_stage && task.result === 'pass') {
          completedTask = task.task_id;
          completedStage = prev.current_stage;
        }
      }

      // Update previous state
      this.prevState = {};
      for (const task of tasks) {
        this.prevState[task.task_id] = { ...task };
      }

      return {
        source_id: this.source_id,
        captured_at: new Date().toISOString(),
        freshness_ms: this.freshness_threshold_ms,
        data: {
          task_count: tasks.length,
          stuck_task: stuckTask,
          stuck_stage: stuckStage,
          stuck_duration_ms: stuckDurationMs,
          failed_task: failedTask,
          failed_stage: failedStage,
          failed_result: failedResult,
          completed_task: completedTask,
          completed_stage: completedStage,
        },
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
