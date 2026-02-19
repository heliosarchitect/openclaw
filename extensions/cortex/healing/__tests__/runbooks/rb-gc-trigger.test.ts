import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbGcTrigger } from "../../runbooks/rb-gc-trigger.js";

describe("RbGcTrigger", () => {
  const def = new RbGcTrigger();

  it("is auto-whitelisted", () => {
    expect(def.auto_approve_whitelist).toBe(true);
  });

  it("applies to memory_pressure", () => {
    expect(def.applies_to).toContain("memory_pressure");
  });

  it("execute returns informational output (no system modification)", async () => {
    const anomaly: HealthAnomaly = {
      id: "a1",
      anomaly_type: "memory_pressure",
      target_id: "system-memory",
      severity: "medium",
      detected_at: "",
      source_id: "test",
      details: { available_mb: 400, total_mb: 16384 },
      remediation_hint: "",
    };
    const steps = def.build(anomaly);
    const result = await steps[0].execute({ anomaly, incident_id: "i1", dry_run: false });
    expect(result.status).toBe("success");
    expect(result.output).toContain("400");
  });
});
