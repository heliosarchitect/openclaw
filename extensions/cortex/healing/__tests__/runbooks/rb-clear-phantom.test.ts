import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbClearPhantom } from "../../runbooks/rb-clear-phantom.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-phantom",
    anomaly_type: "phantom_position",
    target_id: "augur",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "augur-probe",
    details: {},
    remediation_hint: "rb-clear-phantom",
  };
}

describe("RbClearPhantom", () => {
  const rb = new RbClearPhantom();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-clear-phantom");
    expect(rb.applies_to).toContain("phantom_position");
    expect(rb.auto_approve_whitelist).toBe(false);
  });

  it("build returns one step", () => {
    expect(rb.build(makeAnomaly())).toHaveLength(1);
  });

  it("execute returns success (informational only)", async () => {
    const steps = rb.build(makeAnomaly());
    const result = await steps[0].execute();
    expect(result.status).toBe("success");
    expect(result.output).toContain("manual review");
  });

  it("dry_run describes action", async () => {
    const steps = rb.build(makeAnomaly());
    const desc = await steps[0].dry_run();
    expect(desc).toContain("phantom");
  });
});
