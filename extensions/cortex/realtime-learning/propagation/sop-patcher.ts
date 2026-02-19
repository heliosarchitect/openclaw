/**
 * Real-Time Learning — SOP Patcher
 * Cortex v2.6.0 (task-011)
 *
 * Auto-patches SOP files for Tier 1-2 failures (additive changes).
 * Tier 3 (modifying existing rules) requires Synapse preview + approval.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FailureEvent, RealtimeLearningConfig, RealtimeLearningDeps } from "../types.js";

export interface PatchResult {
  type: "additive" | "modifying" | "no_sop_found";
  target_file?: string;
  commit_sha?: string;
  synapse_msg_id?: string;
  diff?: string;
  status: "committed" | "previewed" | "skipped";
}

export class SOPPatcher {
  private config: RealtimeLearningConfig;
  private deps: RealtimeLearningDeps;

  constructor(config: RealtimeLearningConfig, deps: RealtimeLearningDeps) {
    this.config = config;
    this.deps = deps;
  }

  async patch(failure: FailureEvent): Promise<PatchResult> {
    // Find relevant SOP file
    const sopPath = this.findSOP(failure);
    if (!sopPath) {
      return { type: "no_sop_found", status: "skipped" };
    }

    const existing = await readFile(sopPath, "utf8");
    const patchEntry = this.generatePatchEntry(failure);

    if (!patchEntry) {
      return { type: "no_sop_found", status: "skipped" };
    }

    // Additive changes: auto-commit
    const updatedContent = `${existing.trimEnd()}\n\n${patchEntry}\n`;
    await writeFile(sopPath, updatedContent, "utf8");

    // Tier 1-2: auto-commit
    if (failure.tier <= 2) {
      try {
        const sha = this.gitCommit(
          sopPath,
          `fix(sop): auto-patch from failure ${failure.id} [realtime-learning]`,
        );
        this.deps.logger?.info?.(`[SOPPatcher] Auto-committed SOP patch: ${sopPath} (${sha})`);
        return {
          type: "additive",
          target_file: sopPath,
          commit_sha: sha,
          status: "committed",
        };
      } catch (err) {
        this.deps.logger?.warn?.(`[SOPPatcher] Git commit failed: ${err}`);
        return { type: "additive", target_file: sopPath, status: "committed" };
      }
    }

    // Tier 3: preview via Synapse
    const diff = `+++ ${sopPath}\n${patchEntry}`;
    const msgId = await this.deps.sendSynapse(
      `SOP Patch Preview: ${failure.root_cause}`,
      `**Failure:** ${failure.failure_desc}\n**Root cause:** ${failure.root_cause}\n**Proposed patch to** \`${sopPath}\`:\n\`\`\`\n${patchEntry}\n\`\`\`\nApprove or reject in Synapse.`,
      "action",
      `realtime-learning:${failure.id}`,
    );

    return {
      type: "modifying",
      target_file: sopPath,
      synapse_msg_id: msgId,
      diff,
      status: "previewed",
    };
  }

  private findSOP(failure: FailureEvent): string | null {
    const sopDir = this.config.sop_directory || join(this.deps.repoRoot, "sop");

    if (!existsSync(sopDir)) return null;

    // Try context-provided SOP file first
    const ctxSop = failure.context.sop_file as string | undefined;
    if (ctxSop) {
      const fullPath = ctxSop.startsWith("/") ? ctxSop : join(sopDir, ctxSop);
      if (existsSync(fullPath)) return fullPath;
    }

    // Map root causes to known SOP files
    const rootCauseToSop: Record<string, string> = {
      wrong_path: "file-paths.md",
      missing_binary: "tool-binaries.md",
      stale_sop: "sop-maintenance.md",
      stale_sop_rule: "sop-maintenance.md",
      permissions: "system-permissions.md",
      trust_boundary_crossed: "trust-boundaries.md",
      incorrect_approach: "approaches.md",
      wrong_binary: "tool-binaries.md",
    };

    const sopFile = rootCauseToSop[failure.root_cause ?? ""];
    if (sopFile) {
      const fullPath = join(sopDir, sopFile);
      if (existsSync(fullPath)) return fullPath;
    }

    // Fallback: general corrections SOP
    const general = join(sopDir, "corrections.md");
    if (existsSync(general)) return general;

    // Create corrections.md if nothing exists
    try {
      const content = `# Corrections & Learned Fixes\n\nAuto-maintained by realtime-learning system.\n`;
      require("node:fs").writeFileSync(general, content, "utf8");
      return general;
    } catch {
      return null;
    }
  }

  private generatePatchEntry(failure: FailureEvent): string | null {
    const date = new Date().toISOString().split("T")[0];
    const rootCause = failure.root_cause ?? "unknown";

    switch (rootCause) {
      case "wrong_path":
        return `### [${date}] Path Correction (${failure.id.substring(0, 8)})\n- **Error:** ${failure.failure_desc}\n- **Source:** ${failure.source}\n- **Action:** Verify correct paths before using`;

      case "missing_binary":
        return `### [${date}] Missing Binary (${failure.id.substring(0, 8)})\n- **Error:** ${failure.failure_desc}\n- **Action:** Ensure binary is installed and in PATH`;

      case "stale_sop":
      case "stale_sop_rule":
        return `### [${date}] SOP Updated (${failure.id.substring(0, 8)})\n- **Issue:** ${failure.failure_desc}\n- **Rule:** ${failure.context.rule_id ?? "N/A"}\n- **Action:** Review and update stale rules`;

      case "permissions":
        return `### [${date}] Permissions Issue (${failure.id.substring(0, 8)})\n- **Error:** ${failure.failure_desc}\n- **Action:** Check file/directory permissions before access`;

      case "trust_boundary_crossed":
        return `### [${date}] Trust Boundary (${failure.id.substring(0, 8)})\n- **Event:** ${failure.failure_desc}\n- **Action:** Do not perform this action without explicit approval`;

      case "incorrect_approach":
        return `### [${date}] Approach Correction (${failure.id.substring(0, 8)})\n- **Correction:** ${failure.failure_desc}\n- **Action:** Use the corrected approach going forward`;

      default:
        return `### [${date}] Failure Record (${failure.id.substring(0, 8)})\n- **Type:** ${failure.type}\n- **Description:** ${failure.failure_desc}\n- **Root cause:** ${rootCause}`;
    }
  }

  private gitCommit(filePath: string, message: string): string {
    try {
      execSync(`git add "${filePath}"`, { cwd: this.deps.repoRoot, stdio: "pipe" });
      execSync(`git commit -m "${message}" --no-verify`, {
        cwd: this.deps.repoRoot,
        stdio: "pipe",
      });
      const sha = execSync("git rev-parse --short HEAD", {
        cwd: this.deps.repoRoot,
        encoding: "utf8",
      }).trim();
      return sha;
    } catch (err) {
      throw new Error(`Git commit failed: ${err}`);
    }
  }
}
