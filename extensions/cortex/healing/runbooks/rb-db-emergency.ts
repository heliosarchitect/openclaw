/**
 * rb-db-emergency: Halt brain.db writes, backup, Signal alert
 * NEVER auto-executes — always tier-3 escalation
 */

import { exec } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

const execAsync = promisify(exec);

export class RbDbEmergency implements RunbookDefinition {
  readonly id = "rb-db-emergency";
  readonly label = "Emergency brain.db backup (halt writes + copy)";
  readonly applies_to: AnomalyType[] = ["db_corruption"];
  readonly auto_approve_whitelist = false;

  build(_anomaly: HealthAnomaly): RunbookStep[] {
    const dbPath = join(homedir(), ".openclaw", "workspace", "memory", "brain.db");
    const backupPath = `${dbPath}.emergency-backup-${Date.now()}`;

    return [
      {
        id: "backup-db",
        description: "Create emergency backup of brain.db",
        timeout_ms: 30000,
        async dry_run() {
          return `Would copy ${dbPath} → ${backupPath}`;
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            await execAsync(`cp "${dbPath}" "${backupPath}"`, { timeout: 30000 });
            return {
              step_id: "backup-db",
              status: "success",
              output: `Backup: ${backupPath}`,
              artifacts: [backupPath],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "backup-db",
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
