/**
 * Unit tests for Importance Archiver
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { archiveSourceMemories } from "../archiver.js";

describe("archiveSourceMemories", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("downgrades all member memories to importance 0.5", async () => {
    const updates: Array<{ id: string; importance: number }> = [];
    const bridge = {
      runSQL: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("UPDATE") && sql.includes("importance = 0.5")) {
          updates.push({ id: params[1], importance: 0.5 });
        }
      }),
    } as any;

    await archiveSourceMemories(bridge, ["a", "b", "c"], "cluster-1", "compressed-1");

    expect(updates).toHaveLength(3);
    expect(updates.map((u) => u.id)).toEqual(["a", "b", "c"]);
  });

  it("rolls back on partial failure", async () => {
    let callCount = 0;
    const rollbacks: string[] = [];
    const deletions: string[] = [];

    const bridge = {
      runSQL: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("UPDATE") && sql.includes("importance = 0.5")) {
          callCount++;
          if (callCount === 2) throw new Error("DB write failed");
        }
        if (sql.includes("UPDATE") && sql.includes("importance = 1.0")) {
          rollbacks.push(params[0]); // restored ID
        }
        if (sql.includes("DELETE")) {
          deletions.push(params[0]);
        }
      }),
    } as any;

    await expect(
      archiveSourceMemories(bridge, ["a", "b", "c"], "cluster-1", "compressed-1"),
    ).rejects.toThrow("DB write failed");

    // First memory was archived before failure, should be rolled back
    expect(rollbacks).toContain("a");
    // Compressed memory should be deleted
    expect(deletions).toContain("compressed-1");
  });

  it("handles empty member list gracefully", async () => {
    const bridge = { runSQL: vi.fn() } as any;
    await archiveSourceMemories(bridge, [], "cluster-1", "compressed-1");
    expect(bridge.runSQL).not.toHaveBeenCalled();
  });
});
