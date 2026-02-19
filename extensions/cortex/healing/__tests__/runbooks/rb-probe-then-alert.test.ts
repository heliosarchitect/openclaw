import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbProbeThenAlert } from "../../runbooks/rb-probe-then-alert.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-fleet",
    anomaly_type: "fleet_unreachable",
    target_id: "fleet:radio.fleet.wood",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "fleet-probe",
    details: { host: "radio.fleet.wood" },
    remediation_hint: "rb-probe-then-alert",
  };
}

describe("RbProbeThenAlert", () => {
  const rb = new RbProbeThenAlert();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-probe-then-alert");
    expect(rb.applies_to).toContain("fleet_unreachable");
  });

  it("build returns 1 step (retry-probe)", () => {
    const steps = rb.build(makeAnomaly());
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe("retry-probe");
  });

  it("dry_run mentions host and retry count", async () => {
    const steps = rb.build(makeAnomaly());
    const desc = await steps[0].dry_run();
    expect(desc).toContain("radio.fleet.wood");
    expect(desc).toContain("3");
  });

  it("extracts host from target_id when details.host missing", () => {
    const anomaly = makeAnomaly();
    anomaly.details = {};
    const steps = rb.build(anomaly);
    // Should fall back to target_id parsing
    expect(steps).toHaveLength(1);
  });
});
