/**
 * rb-emergency-cleanup: Rotate logs + prune pycache + tmp files
 */

import { exec } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

const execAsync = promisify(exec);

export class RbEmergencyCleanup implements RunbookDefinition {
  readonly id = "rb-emergency-cleanup";
  readonly label = "Emergency disk cleanup (logs + cache + tmp)";
  readonly applies_to: AnomalyType[] = ["disk_critical"];
  readonly auto_approve_whitelist = false;

  build(_anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "rotate-logs",
        description: "Compress all logs > 1 day",
        timeout_ms: 60000,
        async dry_run() {
          return "Would gzip all .log files > 1 day old";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          const home = homedir();
          try {
            await execAsync(
              `find ${home} /var/log -name "*.log" -mtime +1 -exec gzip {} \\; 2>/dev/null || true`,
              { timeout: 60000 },
            );
            return {
              step_id: "rotate-logs",
              status: "success",
              output: "Logs compressed",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "rotate-logs",
              status: "failed",
              output: String(e),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
      {
        id: "prune-pycache",
        description: "Remove __pycache__ directories",
        timeout_ms: 30000,
        async dry_run() {
          return "Would remove all __pycache__ directories under ~/Projects";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            await execAsync(
              `find ${homedir()}/Projects -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true`,
              { timeout: 30000 },
            );
            return {
              step_id: "prune-pycache",
              status: "success",
              output: "pycache pruned",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "prune-pycache",
              status: "failed",
              output: String(e),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
      {
        id: "clean-tmp",
        description: "Remove old /tmp files",
        timeout_ms: 15000,
        async dry_run() {
          return "Would remove /tmp files > 3 days owned by current user";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            await execAsync(`find /tmp -user $(whoami) -mtime +3 -delete 2>/dev/null || true`, {
              timeout: 15000,
            });
            return {
              step_id: "clean-tmp",
              status: "success",
              output: "tmp cleaned",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "clean-tmp",
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
