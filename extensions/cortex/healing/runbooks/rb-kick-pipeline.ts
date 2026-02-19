/**
 * rb-kick-pipeline: Unblock stuck pipeline stage
 *
 * Security: HIGH-001 fix — uses execFile (no shell) with strict input validation.
 * stage and taskId are validated against allowlist regexes before use.
 * Prevents shell injection via crafted pipeline/state.json entries.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

const execFileAsync = promisify(execFile);

// Strict allowlist patterns — anything else is rejected
const SAFE_STAGE = /^[a-z][a-z0-9_-]{0,40}$/;
const SAFE_TASKID = /^task-\d{3}[a-z0-9-]{0,60}$/;

export class RbKickPipeline implements RunbookDefinition {
  readonly id = "rb-kick-pipeline";
  readonly label = "Kick stuck pipeline stage";
  readonly applies_to: AnomalyType[] = ["pipeline_stuck"];
  readonly auto_approve_whitelist = false;

  build(anomaly: HealthAnomaly): RunbookStep[] {
    const taskId = anomaly.details.stuck_task as string | undefined;
    return [
      {
        id: "kick-pipeline",
        description: `Mark stuck pipeline task as blocked: ${taskId ?? "unknown"}`,
        timeout_ms: 10000,
        async dry_run() {
          return `Would call pipeline-stage-done with blocked status for ${taskId ?? "unknown"}`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();

          if (!taskId) {
            return {
              step_id: "kick-pipeline",
              status: "failed",
              output: "No task_id in anomaly details",
              artifacts: [],
              duration_ms: 0,
            };
          }

          const stage = (anomaly.details.stuck_stage as string | undefined) ?? "";

          // HIGH-001: Validate both fields against strict allowlists before shell use
          if (!SAFE_TASKID.test(taskId)) {
            return {
              step_id: "kick-pipeline",
              status: "failed",
              output: `Rejected: taskId '${taskId.slice(0, 40)}' failed validation (expected /^task-\\d{3}[a-z0-9-]+$/)`,
              artifacts: [],
              duration_ms: 0,
            };
          }
          if (!SAFE_STAGE.test(stage)) {
            return {
              step_id: "kick-pipeline",
              status: "failed",
              output: `Rejected: stage '${stage.slice(0, 40)}' failed validation (expected /^[a-z][a-z0-9_-]+$/)`,
              artifacts: [],
              duration_ms: 0,
            };
          }

          try {
            const bin = `${homedir()}/bin/pipeline-stage-done`;
            // execFile: args are passed as a real array — no shell interpolation possible
            await execFileAsync(
              bin,
              [stage, taskId, "blocked", "Auto-kicked by self-healing after timeout"],
              { timeout: 10000 },
            );
            return {
              step_id: "kick-pipeline",
              status: "success",
              output: `Pipeline ${taskId} kicked at stage ${stage}`,
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "kick-pipeline",
              status: "failed",
              output: String(e),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
    ];
  }
}
