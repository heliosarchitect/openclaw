import { describe, expect, it } from "vitest";
import type { FailureEvent, RealtimeLearningDB } from "../../types.js";
import { AtomPropagator } from "../../propagation/atom-propagator.js";

function makeMockDb(hasAtomsTable: boolean): RealtimeLearningDB {
  return {
    get: async (sql: string) => (hasAtomsTable ? { name: "atoms" } : null),
    run: async () => {},
    all: async () => [],
  } as any;
}

function makeFailure(): FailureEvent {
  return {
    id: "fail-001",
    type: "TOOL_ERR",
    source: "exec",
    failure_desc: "exit 1",
    context: {},
    detected_at: new Date().toISOString(),
    root_cause: "missing file",
  } as any;
}

describe("AtomPropagator", () => {
  it("creates atom when atoms table exists", async () => {
    const db = makeMockDb(true);
    const propagator = new AtomPropagator(db);
    const result = await propagator.propagate(makeFailure(), ["sop" as any, "regression" as any]);
    expect(result.success).toBe(true);
    expect(result.detail).toContain("atom:");
  });

  it("skips atom creation when no atoms table", async () => {
    const db = makeMockDb(false);
    const propagator = new AtomPropagator(db);
    const result = await propagator.propagate(makeFailure(), []);
    expect(result.success).toBe(true);
    expect(result.detail).toBe("atoms_table_unavailable");
  });

  it("handles db error gracefully", async () => {
    const db = {
      get: async () => {
        throw new Error("db locked");
      },
      run: async () => {},
      all: async () => [],
    } as any;
    const propagator = new AtomPropagator(db);
    const result = await propagator.propagate(makeFailure(), []);
    expect(result.success).toBe(false);
    expect(result.detail).toContain("db locked");
  });
});
