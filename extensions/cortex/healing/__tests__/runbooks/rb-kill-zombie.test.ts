import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbKillZombie } from "../../runbooks/rb-kill-zombie.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-zombie",
    anomaly_type: "process_zombie",
    target_id: "augur-executor",
    severity: "high",
    detected_at: new Date().toISOString(),
    source_id: "augur-probe",
    details: {},
    remediation_hint: "rb-kill-zombie",
  };
}

describe("RbKillZombie", () => {
  const rb = new RbKillZombie();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-kill-zombie");
    expect(rb.applies_to).toContain("process_zombie");
    expect(rb.auto_approve_whitelist).toBe(false);
  });

  it("build returns one step", () => {
    expect(rb.build(makeAnomaly())).toHaveLength(1);
  });

  it("dry_run mentions target", async () => {
    const steps = rb.build(makeAnomaly());
    const desc = await steps[0].dry_run();
    expect(desc).toContain("augur-executor");
    expect(desc).toContain("SIGKILL");
  });
});
