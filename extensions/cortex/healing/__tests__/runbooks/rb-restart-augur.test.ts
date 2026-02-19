import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbRestartAugur } from "../../runbooks/rb-restart-augur.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-stale",
    anomaly_type: "signal_stale",
    target_id: "augur",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "augur-probe",
    details: {},
    remediation_hint: "rb-restart-augur",
  };
}

describe("RbRestartAugur", () => {
  const rb = new RbRestartAugur();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-restart-augur");
    expect(rb.applies_to).toContain("signal_stale");
  });

  it("build returns 2 steps (kill + start)", () => {
    const steps = rb.build(makeAnomaly());
    expect(steps).toHaveLength(2);
    expect(steps[0].id).toBe("kill-augur");
    expect(steps[1].id).toBe("start-augur");
  });

  it("dry_run describes actions", async () => {
    const steps = rb.build(makeAnomaly());
    expect(await steps[0].dry_run()).toContain("kill");
    expect(await steps[1].dry_run()).toContain("restart");
  });
});
