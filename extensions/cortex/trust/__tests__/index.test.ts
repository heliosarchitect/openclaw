import { describe, expect, it } from "vitest";

describe("trust/index exports", () => {
  it("exports all expected symbols", async () => {
    const mod = await import("../../trust/index.js");
    expect(mod.ActionClassifier).toBeDefined();
    expect(mod.classify).toBeDefined();
    expect(mod.TrustGate).toBeDefined();
    expect(mod.MilestoneDetector).toBeDefined();
    expect(mod.runMigration).toBeDefined();
    expect(mod.OutcomeCollector).toBeDefined();
    expect(mod.detectCorrectionSeverity).toBeDefined();
    expect(mod.OverrideManager).toBeDefined();
    expect(mod.TrustReporter).toBeDefined();
    expect(mod.ScoreUpdater).toBeDefined();
    expect(mod.updateScore).toBeDefined();
  });
});
