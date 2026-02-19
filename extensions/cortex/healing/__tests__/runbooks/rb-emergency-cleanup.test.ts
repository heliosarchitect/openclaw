import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbEmergencyCleanup } from "../../runbooks/rb-emergency-cleanup.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-disk",
    anomaly_type: "disk_critical",
    target_id: "system",
    severity: "critical",
    detected_at: new Date().toISOString(),
    source_id: "disk-probe",
    details: {},
    remediation_hint: "rb-emergency-cleanup",
  };
}

describe("RbEmergencyCleanup", () => {
  const rb = new RbEmergencyCleanup();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-emergency-cleanup");
    expect(rb.applies_to).toContain("disk_critical");
  });

  it("build returns 3 steps (logs + pycache + tmp)", () => {
    const steps = rb.build(makeAnomaly());
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.id)).toEqual(["rotate-logs", "prune-pycache", "clean-tmp"]);
  });

  it("dry_run describes each action", async () => {
    const steps = rb.build(makeAnomaly());
    expect(await steps[0].dry_run()).toContain("gzip");
    expect(await steps[1].dry_run()).toContain("__pycache__");
    expect(await steps[2].dry_run()).toContain("/tmp");
  });
});
