/**
 * rb-rotate-logs: Archive/compress logs > 7 days
 * AUTO-WHITELISTED — starts in auto_execute mode
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

export class RbRotateLogs implements RunbookDefinition {
  readonly id = "rb-rotate-logs";
  readonly label = "Rotate and compress old log files";
  readonly applies_to: AnomalyType[] = ["disk_pressure", "log_bloat"];
  readonly auto_approve_whitelist = true;

  build(_anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "find-old-logs",
        description: "Find log files older than 7 days",
        timeout_ms: 15000,
        async dry_run() {
          return "Would find log files > 7 days old in /var/log, ~/.openclaw/logs, ~/.pm2/logs";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          const home = homedir();
          const dirs = ["/var/log", `${home}/.openclaw/logs`, `${home}/.pm2/logs`].join(" ");
          try {
            const { stdout } = await execAsync(
              `find ${dirs} -name "*.log" -mtime +7 -type f 2>/dev/null || true`,
              { timeout: 15000 },
            );
            const files = stdout.trim().split("\n").filter(Boolean);
            return {
              step_id: "find-old-logs",
              status: "success",
              output: `Found ${files.length} old log files`,
              artifacts: files.slice(0, 20),
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "find-old-logs",
              status: "failed",
              output: String(e),
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          }
        },
      },
      {
        id: "gzip-and-move",
        description: "Compress and archive old logs",
        timeout_ms: 60000,
        async dry_run() {
          return "Would gzip log files > 7 days and move to .archive/ subdirectories";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          const home = homedir();
          const dirs = ["/var/log", `${home}/.openclaw/logs`, `${home}/.pm2/logs`];
          let compressed = 0;
          for (const dir of dirs) {
            try {
              await execAsync(`mkdir -p "${dir}/.archive" 2>/dev/null || true`);
              const { stdout } = await execAsync(
                `find "${dir}" -maxdepth 1 -name "*.log" -mtime +7 -type f 2>/dev/null || true`,
                { timeout: 10000 },
              );
              const files = stdout.trim().split("\n").filter(Boolean);
              for (const f of files) {
                try {
                  await execAsync(
                    `gzip -c "${f}" > "${dir}/.archive/$(basename "${f}").gz" && rm "${f}"`,
                    { timeout: 10000 },
                  );
                  compressed++;
                } catch {
                  /* skip individual file errors */
                }
              }
            } catch {
              /* skip dir errors */
            }
          }
          return {
            step_id: "gzip-and-move",
            status: "success",
            output: `Compressed ${compressed} log files`,
            artifacts: [],
            duration_ms: Date.now() - start,
          };
        },
      },
    ];
  }
}
