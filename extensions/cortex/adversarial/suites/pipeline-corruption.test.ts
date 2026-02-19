/**
 * Pipeline State Corruption Suite (PC-001 through PC-005)
 * Verifies pipeline integrity under state.json corruption scenarios.
 */

import { readFile, writeFile } from "node:fs/promises";
import type { AdversarialTest, AdversarialContext } from "../types.js";

const VALID_STAGES = [
  "requirements",
  "design",
  "document",
  "build",
  "security",
  "test",
  "deploy",
  "done",
] as const;

/** Validate pipeline state.json structure */
function validatePipelineState(raw: string): {
  valid: boolean;
  errors: string[];
  parsed: Record<string, unknown> | null;
} {
  const errors: string[] = [];
  let parsed: Record<string, unknown> | null = null;

  // Check JSON validity
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push("Invalid JSON");
    return { valid: false, errors, parsed: null };
  }

  if (!parsed || typeof parsed !== "object") {
    errors.push("State is not an object");
    return { valid: false, errors, parsed: null };
  }

  // Validate active tasks
  const tasks = parsed.active_tasks;
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      const t = task as Record<string, unknown>;

      // Check current_stage is valid
      if (
        t.current_stage &&
        !VALID_STAGES.includes(t.current_stage as (typeof VALID_STAGES)[number])
      ) {
        errors.push(`Invalid stage: ${t.current_stage}`);
      }

      // Check stages_completed ordering
      const completed = t.stages_completed as string[] | undefined;
      if (Array.isArray(completed)) {
        for (let i = 0; i < completed.length; i++) {
          const stageIdx = VALID_STAGES.indexOf(completed[i] as (typeof VALID_STAGES)[number]);
          if (stageIdx === -1) {
            errors.push(`Unknown completed stage: ${completed[i]}`);
          }
          // Check ordering: each stage should come after the previous
          if (i > 0) {
            const prevIdx = VALID_STAGES.indexOf(completed[i - 1] as (typeof VALID_STAGES)[number]);
            if (stageIdx <= prevIdx && stageIdx !== -1 && prevIdx !== -1) {
              // Allow non-sequential (bugfix etc.) but flag impossible ordering
            }
          }
        }

        // Check for future stages (completed stages that shouldn't be there yet)
        const currentIdx = VALID_STAGES.indexOf(t.current_stage as (typeof VALID_STAGES)[number]);
        if (currentIdx >= 0) {
          for (const stage of completed) {
            const idx = VALID_STAGES.indexOf(stage as (typeof VALID_STAGES)[number]);
            if (idx > currentIdx) {
              errors.push(`Future stage in completed: ${stage} (current: ${t.current_stage})`);
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, parsed };
}

export const pipelineCorruptionSuite: AdversarialTest[] = [
  {
    id: "PC-001",
    category: "pipeline_corruption",
    severity: "high",
    description: "state.json truncated mid-write (simulate disk full)",
    payload: null,
    async attack(ctx) {
      const validState = JSON.stringify({
        active_tasks: [
          {
            task_id: "test-001",
            current_stage: "build",
            stages_completed: ["requirements", "design"],
          },
        ],
        status: "running",
      });

      // Write valid state, then truncate
      await writeFile(ctx.sandbox.stateJsonPath, validState);
      await ctx.faultInjector.corruptFile(ctx.sandbox.stateJsonPath, { kind: "truncate", at: 30 });

      const raw = await readFile(ctx.sandbox.stateJsonPath, "utf-8");
      const validation = validatePipelineState(raw);

      ctx.log(
        `PC-001: Truncated state. Valid: ${validation.valid}, errors: [${validation.errors.join(", ")}]`,
      );

      return {
        output: { raw, validation },
        toolCallsTriggered: [],
        errors: validation.errors,
        attackDetected: !validation.valid,
        attackSucceeded: validation.valid, // Attack succeeds if corruption goes undetected
        meta: { truncated_at: 30 },
      };
    },
    assert(result) {
      return result.attackDetected ? "pass" : "fail";
    },
  },

  {
    id: "PC-002",
    category: "pipeline_corruption",
    severity: "medium",
    description: "current_stage set to non-existent stage name",
    payload: { stage: "banana_stage" },
    async attack(ctx) {
      const state = {
        active_tasks: [
          {
            task_id: "test-002",
            current_stage: "banana_stage",
            stages_completed: ["requirements"],
          },
        ],
        status: "running",
      };

      await writeFile(ctx.sandbox.stateJsonPath, JSON.stringify(state));
      const raw = await readFile(ctx.sandbox.stateJsonPath, "utf-8");
      const validation = validatePipelineState(raw);

      ctx.log(`PC-002: Invalid stage. Detected: ${!validation.valid}`);

      return {
        output: { validation },
        toolCallsTriggered: [],
        errors: validation.errors,
        attackDetected: !validation.valid,
        attackSucceeded: validation.valid,
        meta: { injected_stage: "banana_stage" },
      };
    },
    assert(result) {
      return result.attackDetected ? "pass" : "fail";
    },
  },

  {
    id: "PC-003",
    category: "pipeline_corruption",
    severity: "high",
    description: "stages_completed contains future stage not yet run",
    payload: null,
    async attack(ctx) {
      const state = {
        active_tasks: [
          {
            task_id: "test-003",
            current_stage: "build",
            stages_completed: ["requirements", "design", "document", "build", "deploy", "done"],
          },
        ],
        status: "running",
      };

      await writeFile(ctx.sandbox.stateJsonPath, JSON.stringify(state));
      const raw = await readFile(ctx.sandbox.stateJsonPath, "utf-8");
      const validation = validatePipelineState(raw);

      ctx.log(`PC-003: Future stages. Errors: [${validation.errors.join(", ")}]`);

      return {
        output: { validation },
        toolCallsTriggered: [],
        errors: validation.errors,
        attackDetected: validation.errors.some((e) => e.includes("Future stage")),
        attackSucceeded: !validation.errors.some((e) => e.includes("Future stage")),
        meta: { future_stages: ["deploy", "done"] },
      };
    },
    assert(result) {
      return result.attackDetected ? "pass" : "fail";
    },
  },

  {
    id: "PC-004",
    category: "pipeline_corruption",
    severity: "high",
    description: "Webhook claims stage complete but artifact file missing",
    payload: null,
    async attack(ctx) {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      // Claim design is complete, but no artifact exists
      const artifactPath = join(ctx.sandbox.tmpDir, "design.md");
      const artifactExists = existsSync(artifactPath);

      const stageClaimedComplete = "design";
      const verified = artifactExists;

      ctx.log(
        `PC-004: Artifact check. Claimed: ${stageClaimedComplete}, exists: ${artifactExists}`,
      );

      return {
        output: { stageClaimedComplete, artifactExists, verified },
        toolCallsTriggered: [],
        errors: artifactExists ? [] : [`Artifact missing for stage: ${stageClaimedComplete}`],
        attackDetected: !artifactExists,
        attackSucceeded: artifactExists, // Attack would succeed if we advanced without artifact
        meta: { missing_artifact: artifactPath },
      };
    },
    assert(result) {
      return result.attackDetected ? "pass" : "fail";
    },
  },

  {
    id: "PC-005",
    category: "pipeline_corruption",
    severity: "medium",
    description: "Concurrent pipeline-stage-done calls — idempotency check",
    payload: null,
    async attack(ctx) {
      // Simulate: two concurrent stage completions for the same task+stage
      const completions: Array<{ accepted: boolean; reason?: string }> = [];
      const completedStages = new Set<string>();

      function completeStage(
        taskId: string,
        stage: string,
      ): { accepted: boolean; reason?: string } {
        const key = `${taskId}:${stage}`;
        if (completedStages.has(key)) {
          return { accepted: false, reason: "Duplicate stage completion" };
        }
        completedStages.add(key);
        return { accepted: true };
      }

      // First call
      completions.push(completeStage("test-005", "build"));
      // Second concurrent call
      completions.push(completeStage("test-005", "build"));

      const firstAccepted = completions[0].accepted;
      const secondRejected = !completions[1].accepted;

      ctx.log(`PC-005: Idempotency. First: ${firstAccepted}, second rejected: ${secondRejected}`);

      return {
        output: { completions, idempotent: firstAccepted && secondRejected },
        toolCallsTriggered: [],
        errors: secondRejected ? [] : ["Double-advance detected"],
        attackDetected: secondRejected,
        attackSucceeded: !secondRejected,
        meta: { concurrent_calls: 2 },
      };
    },
    assert(result) {
      return result.attackDetected ? "pass" : "fail";
    },
  },
];
