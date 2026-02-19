import { describe, expect, it } from "vitest";
import type { HealthAnomaly } from "../../types.js";
import { RbGatewayRestart } from "../../runbooks/rb-gateway-restart.js";

function makeAnomaly(): HealthAnomaly {
  return {
    id: "a-gw",
    anomaly_type: "gateway_unresponsive",
    target_id: "gateway",
    severity: "critical",
    detected_at: new Date().toISOString(),
    source_id: "gateway-probe",
    details: {},
    remediation_hint: "rb-gateway-restart",
  };
}

describe("RbGatewayRestart", () => {
  const rb = new RbGatewayRestart();

  it("metadata is correct", () => {
    expect(rb.id).toBe("rb-gateway-restart");
    expect(rb.applies_to).toContain("gateway_unresponsive");
  });

  it("build returns 2 steps (restart + verify)", () => {
    const steps = rb.build(makeAnomaly());
    expect(steps).toHaveLength(2);
    expect(steps[0].id).toBe("restart-gateway");
    expect(steps[1].id).toBe("verify-gateway");
  });

  it("dry_run describes restart", async () => {
    const steps = rb.build(makeAnomaly());
    expect(await steps[0].dry_run()).toContain("openclaw gateway restart");
  });
});
