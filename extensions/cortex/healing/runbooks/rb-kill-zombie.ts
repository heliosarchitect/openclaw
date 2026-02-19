/**
 * rb-kill-zombie: Send SIGKILL to zombie process
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

export class RbKillZombie implements RunbookDefinition {
  readonly id = "rb-kill-zombie";
  readonly label = "Kill zombie process";
  readonly applies_to: AnomalyType[] = ["process_zombie"];
  readonly auto_approve_whitelist = false;

  build(anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "kill-zombie",
        description: `SIGKILL zombie process for ${anomaly.target_id}`,
        timeout_ms: 10000,
        async dry_run() {
          return `Would SIGKILL zombie processes matching ${anomaly.target_id}`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            // Find and kill zombie augur processes
            await execAsync('pkill -9 -f "augur.*executor" || true', { timeout: 10000 });
            return {
              step_id: "kill-zombie",
              status: "success",
              output: "SIGKILL sent",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "kill-zombie",
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
