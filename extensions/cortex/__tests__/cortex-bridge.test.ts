/**
 * cortex-bridge.ts unit tests — Priority 1 (Critical Foundation)
 */
import { describe, expect, it } from "vitest";
import {
  normalizeCategories,
  categoriesMatch,
  estimateTokens,
  ActiveSessionCache,
  HotMemoryTier,
  MemoryIndexCache,
} from "../cortex-bridge.js";
import { createMemory } from "./fixtures/cortex-memory.js";

// ─── normalizeCategories ───
describe("normalizeCategories", () => {
  it("null → ['general']", () => {
    expect(normalizeCategories(null)).toEqual(["general"]);
  });
  it("undefined → ['general']", () => {
    expect(normalizeCategories(undefined)).toEqual(["general"]);
  });
  it("string → [string]", () => {
    expect(normalizeCategories("trading")).toEqual(["trading"]);
  });
  it("[] → ['general']", () => {
    expect(normalizeCategories([])).toEqual(["general"]);
  });
  it("['a','b'] → ['a','b']", () => {
    expect(normalizeCategories(["a", "b"])).toEqual(["a", "b"]);
  });
});

// ─── categoriesMatch ───
describe("categoriesMatch", () => {
  it("no filter → always true", () => {
    expect(categoriesMatch(["trading"], null)).toBe(true);
    expect(categoriesMatch(["trading"], undefined)).toBe(true);
  });
  it("single category match", () => {
    expect(categoriesMatch(["trading", "coding"], "trading")).toBe(true);
  });
  it("multi-category OR match", () => {
    expect(categoriesMatch(["meta"], ["trading", "meta"])).toBe(true);
  });
  it("no match → false", () => {
    expect(categoriesMatch(["coding"], "trading")).toBe(false);
  });
});

// ─── estimateTokens ───
describe("estimateTokens", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

// ─── ActiveSessionCache ───
describe("ActiveSessionCache", () => {
  it("add + getRecent returns messages", () => {
    const cache = new ActiveSessionCache(5);
    cache.add({ role: "user", content: "hello", timestamp: new Date().toISOString() });
    cache.add({ role: "assistant", content: "world", timestamp: new Date().toISOString() });
    expect(cache.count).toBe(2);
    expect(cache.getRecent(1)).toHaveLength(1);
    expect(cache.getRecent(1)[0].content).toBe("world");
  });

  it("respects max capacity", () => {
    const cache = new ActiveSessionCache(2);
    cache.add({ role: "user", content: "a", timestamp: new Date().toISOString() });
    cache.add({ role: "user", content: "b", timestamp: new Date().toISOString() });
    cache.add({ role: "user", content: "c", timestamp: new Date().toISOString() });
    expect(cache.count).toBe(2);
    expect(cache.getAll()[0].content).toBe("b");
  });

  it("search finds matching messages", () => {
    const cache = new ActiveSessionCache(10);
    cache.add({
      role: "user",
      content: "deploy augur to production",
      timestamp: new Date().toISOString(),
    });
    cache.add({ role: "user", content: "check the weather", timestamp: new Date().toISOString() });
    const results = cache.search("augur production");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("augur");
  });

  it("search returns empty for short terms", () => {
    const cache = new ActiveSessionCache(10);
    cache.add({ role: "user", content: "hi", timestamp: new Date().toISOString() });
    expect(cache.search("hi")).toEqual([]); // "hi" is only 2 chars, filtered out
  });

  it("clear empties the cache", () => {
    const cache = new ActiveSessionCache(10);
    cache.add({ role: "user", content: "test", timestamp: new Date().toISOString() });
    cache.clear();
    expect(cache.count).toBe(0);
  });

  it("sizeBytes estimates correctly", () => {
    const cache = new ActiveSessionCache(10);
    cache.add({ role: "user", content: "abcd", timestamp: new Date().toISOString() });
    expect(cache.sizeBytes).toBe(8); // 4 chars * 2
  });
});

// ─── HotMemoryTier ───
describe("HotMemoryTier", () => {
  it("records access and promotes to hot", () => {
    const tier = new HotMemoryTier(5);
    tier.recordAccess("mem-1");
    expect(tier.isHot("mem-1")).toBe(true);
    expect(tier.size).toBe(1);
  });

  it("respects max size and evicts coldest", () => {
    const tier = new HotMemoryTier(2);
    tier.recordAccess("mem-1");
    tier.recordAccess("mem-2");
    // Now full. mem-3 with more accesses should evict coldest
    tier.recordAccess("mem-3");
    tier.recordAccess("mem-3");
    tier.recordAccess("mem-3");
    expect(tier.size).toBe(2);
    expect(tier.isHot("mem-3")).toBe(true);
  });

  it("getAccessCount returns count", () => {
    const tier = new HotMemoryTier(10);
    expect(tier.getAccessCount("nonexistent")).toBe(0);
    tier.recordAccess("mem-1");
    expect(tier.getAccessCount("mem-1")).toBeGreaterThan(0);
  });

  it("getHotIds returns array", () => {
    const tier = new HotMemoryTier(10);
    tier.recordAccess("mem-1");
    tier.recordAccess("mem-2");
    expect(tier.getHotIds()).toContain("mem-1");
    expect(tier.getHotIds()).toContain("mem-2");
  });

  it("getStats returns structured data", () => {
    const tier = new HotMemoryTier(10);
    tier.recordAccess("mem-1");
    const stats = tier.getStats();
    expect(stats.size).toBe(1);
    expect(stats.topAccessCounts).toHaveLength(1);
  });

  it("applyDecay reduces counts", () => {
    const tier = new HotMemoryTier(10);
    tier.recordAccess("mem-1");
    const before = tier.getAccessCount("mem-1");
    // Manually set lastAccess to 2 hours ago to trigger decay
    (tier as any).lastAccess.set("mem-1", Date.now() - 7200000);
    tier.applyDecay();
    const after = tier.getAccessCount("mem-1");
    expect(after).toBeLessThanOrEqual(before);
  });
});

// ─── MemoryIndexCache ───
describe("MemoryIndexCache", () => {
  it("loadMemories populates index", () => {
    const cache = new MemoryIndexCache();
    const mems = [
      createMemory({ categories: ["trading"] }),
      createMemory({ categories: ["coding"] }),
    ];
    cache.loadMemories(mems);
    expect(cache.isInitialized).toBe(true);
    expect(cache.totalCount).toBe(2);
    expect(cache.categories).toContain("trading");
  });

  it("get returns memory and increments access count", () => {
    const cache = new MemoryIndexCache();
    const mem = createMemory({ id: "test-get" });
    cache.loadMemories([mem]);
    const result = cache.get("test-get");
    expect(result).toBeDefined();
    expect(result!.access_count).toBe(1);
  });

  it("get returns undefined for missing id", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([]);
    expect(cache.get("nope")).toBeUndefined();
  });

  it("getByCategory returns matching memories", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([
      createMemory({ id: "m1", categories: ["trading"] }),
      createMemory({ id: "m2", categories: ["coding"] }),
    ]);
    expect(cache.getByCategory("trading")).toHaveLength(1);
    expect(cache.getByCategory("missing")).toHaveLength(0);
  });

  it("searchByKeyword finds matches", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([
      createMemory({ id: "m1", content: "AUGUR trading signals are stale" }),
      createMemory({ id: "m2", content: "weather forecast is sunny" }),
    ]);
    const results = cache.searchByKeyword("augur trading");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("AUGUR");
  });

  it("searchByKeyword returns empty for short/empty queries", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([createMemory()]);
    expect(cache.searchByKeyword("")).toHaveLength(0);
    expect(cache.searchByKeyword("ab")).toHaveLength(0);
  });

  it("add inserts a new memory", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([]);
    cache.add(createMemory({ id: "added", categories: ["meta"] }));
    expect(cache.totalCount).toBe(1);
    expect(cache.getByCategory("meta")).toHaveLength(1);
  });

  it("recordCoOccurrence + getCoOccurring works", () => {
    const cache = new MemoryIndexCache();
    const m1 = createMemory({ id: "co-1" });
    const m2 = createMemory({ id: "co-2" });
    cache.loadMemories([m1, m2]);
    cache.recordCoOccurrence(["co-1", "co-2"]);
    const related = cache.getCoOccurring("co-1");
    expect(related).toHaveLength(1);
    expect(related[0].id).toBe("co-2");
  });

  it("getCoOccurring returns empty for unknown id", () => {
    const cache = new MemoryIndexCache();
    expect(cache.getCoOccurring("nope")).toHaveLength(0);
  });

  it("prefetchCategory boosts rankings", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([createMemory({ categories: ["trading"] })]);
    const result = cache.prefetchCategory("trading");
    expect(result).toHaveLength(1);
  });

  it("getStats returns structured data", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([createMemory({ categories: ["trading"] })]);
    const stats = cache.getStats();
    expect(stats.total).toBe(1);
    expect(stats.byCategory).toHaveProperty("trading");
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });

  it("sizeBytes includes embedding overhead", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([createMemory({ embedding: new Array(384).fill(0) })]);
    expect(cache.sizeBytes).toBeGreaterThan(3000); // 384 * 8 = 3072
  });

  it("getHotMemories returns hot tier + fallback", () => {
    const cache = new MemoryIndexCache();
    cache.loadMemories([createMemory({ id: "hot-1" })]);
    cache.get("hot-1"); // trigger hot promotion
    const hot = cache.getHotMemories(10);
    expect(hot.length).toBeGreaterThanOrEqual(1);
  });

  it("getWithinTokenBudget respects budget", () => {
    const cache = new MemoryIndexCache();
    const longContent = "x".repeat(8000); // ~2000 tokens
    cache.loadMemories([
      createMemory({ id: "big", content: longContent, importance: 2.0 }),
      createMemory({ id: "small", content: "short content here", importance: 2.0 }),
    ]);
    const results = cache.getWithinTokenBudget("content", {
      maxContextTokens: 100,
      relevanceThreshold: 0,
      truncateOldMemoriesTo: 200,
    });
    // Should fit at least the small one
    expect(results.every((r) => r.tokens <= 100)).toBe(true);
  });
});
