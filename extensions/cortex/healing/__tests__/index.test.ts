import { describe, expect, it } from "vitest";

describe("healing/index exports", () => {
  it("exports healing types", async () => {
    // Verify the types file is importable
    const types = await import("../../healing/types.js");
    expect(types).toBeDefined();
  });

  it("exports probe-registry", async () => {
    const mod = await import("../../healing/probe-registry.js");
    expect(mod.HealingProbeRegistry).toBeDefined();
  });

  it("exports runbook-registry", async () => {
    const mod = await import("../../healing/runbook-registry.js");
    expect(mod).toBeDefined();
  });

  it("exports escalation-router", async () => {
    const mod = await import("../../healing/escalation-router.js");
    expect(mod).toBeDefined();
  });
});
