/**
 * rb-gateway-restart: Restart OpenClaw gateway
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

export class RbGatewayRestart implements RunbookDefinition {
  readonly id = "rb-gateway-restart";
  readonly label = "Restart OpenClaw gateway";
  readonly applies_to: AnomalyType[] = ["gateway_unresponsive"];
  readonly auto_approve_whitelist = false;

  build(_anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "restart-gateway",
        description: "Restart OpenClaw gateway service",
        timeout_ms: 30000,
        async dry_run() {
          return "Would run: openclaw gateway restart";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            const { stdout } = await execAsync("openclaw gateway restart 2>&1", { timeout: 30000 });
            return {
              step_id: "restart-gateway",
              status: "success",
              output: stdout.trim(),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "restart-gateway",
              status: "failed",
              output: String(e),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
      {
        id: "verify-gateway",
        description: "Verify gateway is responding",
        timeout_ms: 30000,
        async dry_run() {
          return "Would verify gateway status after restart";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 5000)); // Wait for restart
          try {
            const { stdout } = await execAsync("openclaw gateway status 2>&1", { timeout: 10000 });
            const ok =
              stdout.toLowerCase().includes("running") || stdout.toLowerCase().includes("ok");
            return {
              step_id: "verify-gateway",
              status: ok ? "success" : "failed",
              output: ok ? "Gateway running" : `Gateway status: ${stdout.trim()}`,
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "verify-gateway",
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
