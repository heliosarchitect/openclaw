/**
 * rb-force-gc: Kill highest-memory non-critical process
 *
 * Security: HIGH-002 fix — PID is validated as a positive integer before kill.
 * TOCTOU mitigation: process is re-verified against the protection list immediately
 * before SIGKILL by querying /proc/<pid>/comm (Linux) or ps -p (fallback).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AnomalyType,
  HealthAnomaly,
  RunbookDefinition,
  RunbookStep,
  RunbookStepResult,
} from "../types.js";

const execFileAsync = promisify(execFile);

// Processes that must never be killed (exact comm name match, lowercase)
const PROTECTED = new Set([
  "openclaw",
  "node",
  "sshd",
  "systemd",
  "bash",
  "signal-cli",
  "openclaw-gatew",
]);

/** Validate PID is a positive integer string (not 0, not 1) */
function isValidPid(pid: string): boolean {
  return /^\d+$/.test(pid) && pid !== "0" && pid !== "1";
}

/** Get the comm name for a PID — used for TOCTOU re-check before SIGKILL */
async function getProcessComm(pid: string): Promise<string | null> {
  try {
    // Linux: /proc/<pid>/comm is the most reliable, exact process name
    const { stdout } = await execFileAsync("cat", [`/proc/${pid}/comm`], { timeout: 2000 });
    return stdout.trim().toLowerCase();
  } catch {
    try {
      // Fallback for non-Linux (macOS, etc.)
      const { stdout } = await execFileAsync("ps", ["-p", pid, "-o", "comm="], { timeout: 2000 });
      return stdout.trim().toLowerCase();
    } catch {
      return null; // PID no longer exists — skip it
    }
  }
}

export class RbForceGc implements RunbookDefinition {
  readonly id = "rb-force-gc";
  readonly label = "Force-kill highest memory non-critical process";
  readonly applies_to: AnomalyType[] = ["memory_critical"];
  readonly auto_approve_whitelist = false;

  build(anomaly: HealthAnomaly): RunbookStep[] {
    return [
      {
        id: "kill-top-mem",
        description: "Identify and kill highest-memory non-critical process",
        timeout_ms: 15000,
        async dry_run() {
          return "Would identify highest-memory non-critical process and SIGKILL it";
        },
        async execute(): Promise<RunbookStepResult> {
          const start = Date.now();
          try {
            // List top-20 memory consumers, sorted descending — using execFile (no shell)
            const { stdout } = await execFileAsync("ps", ["aux", "--sort=-%mem"], {
              timeout: 5000,
            });

            const lines = stdout.trim().split("\n").slice(1); // skip header
            for (const line of lines) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[1];
              const cmd = parts.slice(10).join(" ");

              // HIGH-002: Validate PID is a positive integer before any use
              if (!isValidPid(pid)) continue;

              // First-pass protection check against parsed cmd
              const isProtectedByCmd = [...PROTECTED].some((p) => cmd.toLowerCase().includes(p));
              if (isProtectedByCmd) continue;

              // HIGH-002 TOCTOU mitigation: re-query the PID's comm name immediately
              // before kill — the PID may have been recycled since ps ran
              const comm = await getProcessComm(pid);
              if (comm === null) continue; // PID already gone — next candidate

              const isProtectedByComm = [...PROTECTED].some(
                (p) => comm === p || comm.startsWith(p),
              );
              if (isProtectedByComm) continue;

              // Kill using execFile — no shell interpolation
              await execFileAsync("kill", ["-9", pid], { timeout: 5000 });

              return {
                step_id: "kill-top-mem",
                status: "success",
                output: `Killed PID ${pid} (comm=${comm}, cmd=${cmd.slice(0, 80)})`,
                artifacts: [],
                duration_ms: Date.now() - start,
              };
            }

            return {
              step_id: "kill-top-mem",
              status: "failed",
              output: "No killable process found",
              artifacts: [],
              duration_ms: Date.now() - start,
            };
          } catch (e) {
            return {
              step_id: "kill-top-mem",
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
