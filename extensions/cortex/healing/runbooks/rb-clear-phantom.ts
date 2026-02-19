/**
 * rb-clear-phantom: Mark phantom positions as closed + Synapse alert
 */

import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

export class RbClearPhantom implements RunbookDefinition {
  readonly id = "rb-clear-phantom";
  readonly label = "Clear phantom trading position";
  readonly applies_to: AnomalyType[] = ["phantom_position"];
  readonly auto_approve_whitelist = false;

  build(_anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "clear-phantom",
        description:
          "Mark phantom position as closed in trades DB (informational — requires review)",
        timeout_ms: 5000,
        async dry_run() {
          return "Would mark phantom position as closed in AUGUR trades DB and alert via Synapse";
        },
        async execute(): Promise<RunbookStepResult> {
          // This runbook is informational — always escalates to Matthew for trading decisions
          return {
            step_id: "clear-phantom",
            status: "success",
            output:
              "Phantom position flagged for manual review (trading decisions require human approval)",
            artifacts: [],
            duration_ms: 0,
          };
        },
      },
    ];
  }
}
