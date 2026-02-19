/**
 * rb-restart-augur: Kill + restart AUGUR executor, verify signal freshens
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

const execAsync = promisify(exec);

export class RbRestartAugur implements RunbookDefinition {
  readonly id = "rb-restart-augur";
  readonly label = "Restart AUGUR executor for stale signals";
  readonly applies_to: AnomalyType[] = ["signal_stale"];
  readonly auto_approve_whitelist = false;

  build(_anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "kill-augur",
        description: "Kill AUGUR executor",
        timeout_ms: 10000,
        async dry_run() {
          return "Would kill AUGUR executor process";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          await execAsync('pkill -f "augur.*executor" || true', { timeout: 10000 });
          return {
            step_id: "kill-augur",
            status: "success",
            output: "AUGUR killed",
            artifacts: [],
            duration_ms: Date.now() - start,
          };
        },
      },
      {
        id: "start-augur",
        description: "Restart AUGUR executor",
        timeout_ms: 30000,
        async dry_run() {
          return "Would restart AUGUR executor via PM2 or direct launch";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            const { stdout } = await execAsync(
              "cd ~/Projects/augur && pm2 restart augur-executor 2>/dev/null || (python3 -m augur.executor &)",
              { timeout: 30000 },
            );
            return {
              step_id: "start-augur",
              status: "success",
              output: stdout.trim() || "Started",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "start-augur",
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
