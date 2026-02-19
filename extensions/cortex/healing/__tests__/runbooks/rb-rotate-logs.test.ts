import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbRotateLogs } from "../../runbooks/rb-rotate-logs.js";

describe("RbRotateLogs", () => {
  const def = new RbRotateLogs();

  it("requires approval (not auto-whitelisted — FINDING-002)", () => {
    expect(def.auto_approve_whitelist).toBe(false);
  });

  it("applies to disk_pressure and log_bloat", () => {
    expect(def.applies_to).toContain("disk_pressure");
    expect(def.applies_to).toContain("log_bloat");
  });

  it("builds 2 steps", () => {
    const anomaly: HealthAnomaly = {
      id: "a1",
      anomaly_type: "disk_pressure",
      target_id: "disk:/",
      severity: "high",
      detected_at: "",
      source_id: "test",
      details: {},
      remediation_hint: "",
    };
    const steps = def.build(anomaly);
    expect(steps).toHaveLength(2);
    expect(steps[0].id).toBe("find-old-logs");
    expect(steps[1].id).toBe("gzip-and-move");
  });

  it("dry_run returns description", async () => {
    const anomaly: HealthAnomaly = {
      id: "a1",
      anomaly_type: "log_bloat",
      target_id: "log-files",
      severity: "medium",
      detected_at: "",
      source_id: "test",
      details: {},
      remediation_hint: "",
    };
    const steps = def.build(anomaly);
    const desc = await steps[0].dry_run();
    expect(desc).toContain("log files");
  });
});
