/**
 * rb-probe-then-alert: Retry 3x at 30s intervals for fleet unreachable, then alert
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

export class RbProbeThenAlert implements RunbookDefinition {
  readonly id = "rb-probe-then-alert";
  readonly label = "Retry probe 3x then alert for unreachable fleet host";
  readonly applies_to: AnomalyType[] = ["fleet_unreachable"];
  readonly auto_approve_whitelist = false;

  build(anomaly: HealthAnomaly): RunbookStep[] {
    const host = (anomaly.details.host as string) ?? anomaly.target_id.replace("fleet:", "");

    return [
      {
        id: "retry-probe",
        description: `Retry SSH probe 3x for ${host}`,
        timeout_ms: 120000,
        async dry_run() {
          return `Would retry SSH probe to ${host} 3 times at 30s intervals`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          for (let i = 0; i < 3; i++) {
            try {
              await execAsync(
                `ssh -o ConnectTimeout=5 -o BatchMode=yes ${host} echo ok 2>/dev/null`,
                { timeout: 10000 },
              );
              return {
                step_id: "retry-probe",
                status: "success",
                output: `Host ${host} reachable on attempt ${i + 1}`,
                artifacts: [],
                duration_ms: Date.now() - start,
              };
            } catch {
              if (i < 2) await new Promise((r) => setTimeout(r, 30000));
            }
          }
          return {
            step_id: "retry-probe",
            status: "failed",
            output: `Host ${host} unreachable after 3 retries`,
            artifacts: [],
            duration_ms: Date.now() - start,
          };
        },
      },
    ];
  }
}
