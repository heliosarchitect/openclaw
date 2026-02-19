import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbRestartService } from "../../runbooks/rb-restart-service.js";

function makeAnomaly(target = "augur-executor"): HealthAnomaly {
  return {
    id: "a-dead",
    anomaly_type: "process_dead",
    target_id: target,
    severity: "critical",
    detected_at: new Date().toISOString(),
    source_id: "process-probe",
    details: {},
    remediation_hint: "rb-restart-service",
  };
}

describe("RbRestartService", () => {
  const rb = new RbRestartService();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-restart-service");
    expect(rb.applies_to).toContain("process_dead");
  });

  it("build returns 3 steps for known service", () => {
    const steps = rb.build(makeAnomaly("augur-executor"));
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.id)).toEqual(["kill-old", "start-service", "verify-pid"]);
  });

  it("build returns empty for unknown service", () => {
    const steps = rb.build(makeAnomaly("unknown-service"));
    expect(steps).toHaveLength(0);
  });

  it("dry_run describes kill command", async () => {
    const steps = rb.build(makeAnomaly("augur-executor"));
    const desc = await steps[0].dry_run();
    expect(desc).toContain("pkill");
  });
});
