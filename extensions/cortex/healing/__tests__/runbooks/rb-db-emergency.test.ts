import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbDbEmergency } from "../../runbooks/rb-db-emergency.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-db",
    anomaly_type: "db_corruption",
    target_id: "brain.db",
    severity: "critical",
    detected_at: new Date().toISOString(),
    source_id: "brain-db-probe",
    details: {},
    remediation_hint: "rb-db-emergency",
  };
}

describe("RbDbEmergency", () => {
  const rb = new RbDbEmergency();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-db-emergency");
    expect(rb.applies_to).toContain("db_corruption");
    expect(rb.auto_approve_whitelist).toBe(false);
  });

  it("build returns backup step", () => {
    const steps = rb.build(makeAnomaly());
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe("backup-db");
  });

  it("dry_run describes backup action", async () => {
    const steps = rb.build(makeAnomaly());
    const desc = await steps[0].dry_run();
    expect(desc).toContain("copy");
    expect(desc).toContain("brain.db");
  });
});
