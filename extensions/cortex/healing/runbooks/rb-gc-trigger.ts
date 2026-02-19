/**
 * rb-gc-trigger: Log memory state + Synapse notify (informational only)
 * AUTO-WHITELISTED
 */

import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

export class RbGcTrigger implements RunbookDefinition {
  readonly id = "rb-gc-trigger";
  readonly label = "Log memory pressure and notify";
  readonly applies_to: AnomalyType[] = ["memory_pressure"];
  readonly auto_approve_whitelist = true;

  build(anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "log-memory",
        description: "Log current memory state (informational)",
        timeout_ms: 5000,
        async dry_run() {
          return `Would log memory state: ${anomaly.details.available_mb ?? "?"}MB available`;
        },
        async execute(): Promise<RunbookStepResult> {
          return {
            step_id: "log-memory",
            status: "success",
            output: `Memory pressure detected: ${anomaly.details.available_mb ?? "?"}MB available / ${anomaly.details.total_mb ?? "?"}MB total`,
            artifacts: [],
            duration_ms: 0,
          };
        },
      },
    ];
  }
}
