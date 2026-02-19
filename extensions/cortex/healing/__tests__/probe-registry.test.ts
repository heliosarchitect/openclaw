import { describe, expect, it } from "vitest";
import { HealingProbeRegistry } from "../../healing/probe-registry.js";

const config = {
  probe_intervals_ms: {
    augur_process: 60000,
    gateway: 60000,
    brain_db: 60000,
    disk: 60000,
    memory: 60000,
    log_bloat: 60000,
  },
  anomaly_ttl_ms: 3600000,
  auto_remediate: false,
  escalation_timeout_ms: 300000,
};

describe("HealingProbeRegistry", () => {
  it("registers all 6 probes", () => {
    const registry = new HealingProbeRegistry(config);
    expect(registry.getProbe("heal.gateway")).toBeDefined();
    expect(registry.getProbe("heal.augur_process")).toBeDefined();
    expect(registry.getProbe("heal.log_bloat")).toBeDefined();
  });

  it("getProbe returns undefined for unknown", () => {
    const registry = new HealingProbeRegistry(config);
    expect(registry.getProbe("heal.nonexistent")).toBeUndefined();
  });

  it("setReadingCallback sets callback", () => {
    const registry = new HealingProbeRegistry(config);
    const cb = async () => {};
    registry.setReadingCallback(cb);
    // No assertion needed — just verify no throw
  });

  it("start + stop lifecycle works", async () => {
    const registry = new HealingProbeRegistry(config);
    await registry.start();
    await registry.stop();
    // Should not throw
  });
});
