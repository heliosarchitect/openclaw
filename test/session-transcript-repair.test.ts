import { describe, expect, it } from "vitest";

/**
 * Export regression guard for session-transcript-repair.
 *
 * On 2026-02-18 a merge silently dropped ~80 lines from this module,
 * removing sanitizeToolCallInputs, stripToolResultDetails, and
 * repairToolCallInputs. The build still passed because the exports
 * were only consumed at runtime. This test ensures that never
 * happens again.
 */
describe("session-transcript-repair exports", () => {
  it("exports sanitizeToolCallInputs", async () => {
    const mod = await import("../src/agents/session-transcript-repair.js");
    expect(typeof mod.sanitizeToolCallInputs).toBe("function");
  });

  it("exports stripToolResultDetails", async () => {
    const mod = await import("../src/agents/session-transcript-repair.js");
    expect(typeof mod.stripToolResultDetails).toBe("function");
  });

  it("exports repairToolCallInputs", async () => {
    const mod = await import("../src/agents/session-transcript-repair.js");
    expect(typeof mod.repairToolCallInputs).toBe("function");
  });

  it("exports sanitizeToolUseResultPairing", async () => {
    const mod = await import("../src/agents/session-transcript-repair.js");
    expect(typeof mod.sanitizeToolUseResultPairing).toBe("function");
  });

  it("exports repairToolUseResultPairing", async () => {
    const mod = await import("../src/agents/session-transcript-repair.js");
    expect(typeof mod.repairToolUseResultPairing).toBe("function");
  });

  it("exports makeMissingToolResult", async () => {
    const mod = await import("../src/agents/session-transcript-repair.js");
    expect(typeof mod.makeMissingToolResult).toBe("function");
  });
});
