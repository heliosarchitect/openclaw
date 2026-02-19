/**
 * Unit tests for Memory Writer
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryCluster, DistillationResult } from "../types.js";
import { writeCompressedMemory } from "../memory-writer.js";

function makeCluster(ids: string[]): MemoryCluster {
  return {
    cluster_id: "cluster-001",
    member_ids: ids,
    member_count: ids.length,
    avg_similarity: 0.88,
    dominant_category: "trading",
    total_tokens: 600,
    oldest_member_at: "2026-01-15T00:00:00Z",
    fingerprint: "fp123",
  };
}

function makeDistillation(): DistillationResult {
  return {
    abstraction: "Whale wallets accumulate BNKR tokens before price spikes.",
    compression_ratio: 3.5,
    is_causal: true,
  };
}

describe("writeCompressedMemory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Stub fetch for embeddings daemon
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("writes memory with correct categories (top-2 + compressed)", async () => {
    let insertedCategories = "";
    const bridge = {
      getSQL: vi
        .fn()
        .mockResolvedValueOnce({ max_imp: 1.8 }) // max importance
        .mockResolvedValueOnce({ min_ts: "2026-01-10T00:00:00Z", max_ts: "2026-01-20T00:00:00Z" }), // date range
      allSQL: vi
        .fn()
        .mockResolvedValue([
          { categories: '["trading","signals"]' },
          { categories: '["trading","augur"]' },
          { categories: '["signals","augur"]' },
        ]),
      runSQL: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("INSERT INTO stm")) {
          insertedCategories = params[2]; // categories param
        }
      }),
    } as any;

    const id = await writeCompressedMemory(
      bridge,
      makeCluster(["a", "b", "c"]),
      makeDistillation(),
    );
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const cats = JSON.parse(insertedCategories);
    expect(cats).toContain("compressed");
    // Top 2 by frequency: trading (3), signals (2) or augur (2)
    expect(cats).toContain("trading");
    expect(cats.length).toBeLessThanOrEqual(3);
  });

  it("uses max importance from source memories", async () => {
    let insertedImportance = 0;
    const bridge = {
      getSQL: vi
        .fn()
        .mockResolvedValueOnce({ max_imp: 2.3 })
        .mockResolvedValueOnce({ min_ts: "2026-01-01T00:00:00Z", max_ts: "2026-01-10T00:00:00Z" }),
      allSQL: vi.fn().mockResolvedValue([{ categories: '["general"]' }]),
      runSQL: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("INSERT INTO stm")) {
          insertedImportance = params[3]; // importance param
        }
      }),
    } as any;

    await writeCompressedMemory(bridge, makeCluster(["a"]), makeDistillation());
    expect(insertedImportance).toBe(2.3);
  });

  it("stores compressed_from as JSON array of source IDs", async () => {
    let insertedCompressedFrom = "";
    const bridge = {
      getSQL: vi
        .fn()
        .mockResolvedValueOnce({ max_imp: 1.0 })
        .mockResolvedValueOnce({ min_ts: "2026-01-01T00:00:00Z", max_ts: "2026-01-01T00:00:00Z" }),
      allSQL: vi.fn().mockResolvedValue([{ categories: '["general"]' }]),
      runSQL: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes("INSERT INTO stm")) {
          insertedCompressedFrom = params[5]; // compressed_from param
        }
      }),
    } as any;

    const ids = ["mem-1", "mem-2", "mem-3"];
    await writeCompressedMemory(bridge, makeCluster(ids), makeDistillation());
    expect(JSON.parse(insertedCompressedFrom)).toEqual(ids);
  });

  it("handles embeddings daemon failure gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

    const bridge = {
      getSQL: vi
        .fn()
        .mockResolvedValueOnce({ max_imp: 1.0 })
        .mockResolvedValueOnce({ min_ts: "2026-01-01T00:00:00Z", max_ts: "2026-01-01T00:00:00Z" }),
      allSQL: vi.fn().mockResolvedValue([{ categories: '["general"]' }]),
      runSQL: vi.fn(),
    } as any;

    // Should not throw even if embeddings daemon is down
    const id = await writeCompressedMemory(bridge, makeCluster(["a"]), makeDistillation());
    expect(id).toBeTruthy();
  });
});
