/**
 * Unit tests for Distiller
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryCluster } from "../types.js";
import { distillCluster } from "../distiller.js";

// Mock CortexBridge
function mockBridge(
  members: Array<{ id: string; content: string; categories: string; importance: number }>,
) {
  return {
    allSQL: vi.fn().mockResolvedValue(members),
    getSQL: vi.fn().mockResolvedValue(null),
    runSQL: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeCluster(memberIds: string[]): MemoryCluster {
  return {
    cluster_id: "test-cluster-1",
    member_ids: memberIds,
    member_count: memberIds.length,
    avg_similarity: 0.88,
    dominant_category: "test",
    total_tokens: 500,
    oldest_member_at: "2026-01-01T00:00:00Z",
    fingerprint: "abc123",
  };
}

describe("distillCluster", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if ANTHROPIC_API_KEY is not set", async () => {
    const bridge = mockBridge([]);
    const cluster = makeCluster(["a", "b", "c"]);
    await expect(distillCluster(bridge, cluster, { apiKey: "" })).rejects.toThrow(
      "ANTHROPIC_API_KEY",
    );
  });

  it("returns null if no members found in DB", async () => {
    const bridge = mockBridge([]);
    const cluster = makeCluster(["a", "b", "c"]);
    // Mock fetch for API call — shouldn't be reached
    const result = await distillCluster(bridge, cluster, { apiKey: "test-key" });
    expect(result).toBeNull();
  });

  it("returns null when compression ratio < 1.5", async () => {
    const bridge = mockBridge([
      { id: "a", content: "short memory", categories: '["test"]', importance: 1.0 },
      { id: "b", content: "another short", categories: '["test"]', importance: 1.0 },
      { id: "c", content: "third short", categories: '["test"]', importance: 1.0 },
    ]);
    const cluster = makeCluster(["a", "b", "c"]);

    // Mock fetch to return low compression ratio
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"abstraction": "combined short memories about testing", "compression_ratio": 1.1, "is_causal": false}',
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await distillCluster(bridge, cluster, { apiKey: "test-key" });
    expect(result).toBeNull();
  });

  it("returns valid distillation on success", async () => {
    const bridge = mockBridge([
      {
        id: "a",
        content:
          "Memory about whale accumulation patterns in BNKR token over 3 days showing consistent buying",
        categories: '["trading"]',
        importance: 1.5,
      },
      {
        id: "b",
        content:
          "Whale wallet 0xabc accumulated 500K BNKR in a span of 72 hours preceding major price move",
        categories: '["trading"]',
        importance: 1.8,
      },
      {
        id: "c",
        content:
          "BNKR token showed whale accumulation pattern before price spike, consistent with prior observations",
        categories: '["trading"]',
        importance: 1.2,
      },
    ]);
    const cluster = makeCluster(["a", "b", "c"]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: '{"abstraction": "Whale wallets accumulate BNKR tokens over 72h periods before price spikes.", "compression_ratio": 4.2, "is_causal": true}',
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await distillCluster(bridge, cluster, { apiKey: "test-key" });
    expect(result).not.toBeNull();
    expect(result!.abstraction).toContain("BNKR");
    expect(result!.is_causal).toBe(true);
    // compression_ratio is recomputed from actual tokens
    expect(result!.compression_ratio).toBeGreaterThan(1.5);
  });

  it("throws on API error", async () => {
    const bridge = mockBridge([
      { id: "a", content: "test", categories: '["test"]', importance: 1.0 },
    ]);
    const cluster = makeCluster(["a"]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(distillCluster(bridge, cluster, { apiKey: "test-key" })).rejects.toThrow("429");
  });

  it("throws on invalid JSON response", async () => {
    const bridge = mockBridge([
      { id: "a", content: "test content here", categories: '["test"]', importance: 1.0 },
    ]);
    const cluster = makeCluster(["a"]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "This is not JSON at all" }],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(distillCluster(bridge, cluster, { apiKey: "test-key" })).rejects.toThrow(
      "invalid JSON",
    );
  });
});
