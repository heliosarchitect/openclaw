/**
 * rb-restart-service: Restart known services (AUGUR, signal-cli)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  AnomalyType,
  HealthAnomaly,
  RunbookContext,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

const execAsync = promisify(exec);

const SERVICE_MAP: Record<string, { kill_cmd: string; start_cmd: string; verify_cmd: string }> = {
  "augur-executor": {
    kill_cmd: 'pkill -f "augur.*executor" || true',
    start_cmd:
      "cd ~/Projects/augur && pm2 restart augur-executor 2>/dev/null || (python3 -m augur.executor &)",
    verify_cmd: 'ps aux | grep -c "[a]ugur.*executor"',
  },
  "signal-cli": {
    kill_cmd: "systemctl --user stop signal-cli.service || true",
    start_cmd: "systemctl --user start signal-cli.service",
    verify_cmd: "systemctl --user is-active signal-cli.service",
  },
};

export class RbRestartService implements RunbookDefinition {
  readonly id = "rb-restart-service";
  readonly label = "Restart dead service";
  readonly applies_to: AnomalyType[] = ["process_dead"];
  readonly auto_approve_whitelist = false;

  build(anomaly: HealthAnomaly): RunbookStep[] {
    const service = SERVICE_MAP[anomaly.target_id];
    if (!service) return [];

    return [
      {
        id: "kill-old",
        description: `Kill stale process for ${anomaly.target_id}`,
        timeout_ms: 10000,
        async dry_run() {
          return `Would run: ${service.kill_cmd}`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            await execAsync(service.kill_cmd, { timeout: 10000 });
            return {
              step_id: "kill-old",
              status: "success",
              output: "Process killed",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "kill-old",
              status: "success",
              output: "No process to kill",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
      {
        id: "start-service",
        description: `Start ${anomaly.target_id}`,
        timeout_ms: 30000,
        async dry_run() {
          return `Would run: ${service.start_cmd}`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            const { stdout } = await execAsync(service.start_cmd, { timeout: 30000 });
            return {
              step_id: "start-service",
              status: "success",
              output: stdout.trim(),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "start-service",
              status: "failed",
              output: String(e),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
      {
        id: "verify-pid",
        description: `Verify ${anomaly.target_id} is running`,
        timeout_ms: 5000,
        async dry_run() {
          return `Would run: ${service.verify_cmd}`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          // Wait a moment for process to start
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const { stdout } = await execAsync(service.verify_cmd, { timeout: 5000 });
            const running = Number.parseInt(stdout.trim(), 10) > 0 || stdout.trim() === "active";
            return {
              step_id: "verify-pid",
              status: running ? "success" : "failed",
              output: running ? "Service running" : "Service not detected",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "verify-pid",
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
