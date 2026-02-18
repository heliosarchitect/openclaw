/**
 * Unit Tests — EnforcementEngine
 * Pre-Action Hook System v2.0.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KnowledgeContext, KnowledgeResult } from "../knowledge-discovery.js";
import { EnforcementEngine, EnforcementLevel } from "../enforcement-engine.js";

function makeContext(overrides: Partial<KnowledgeContext> = {}): KnowledgeContext {
  return {
    toolName: "exec",
    params: { command: "docker compose up" },
    keywords: ["docker", "compose"],
    riskLevel: "medium",
    ...overrides,
  };
}

function makeKnowledge(overrides: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    sopFiles: [
      {
        label: "Docker Deploy",
        path: "/sop/docker.ai.sop",
        content: "## preflight\nCheck images",
        priority: 7,
        matchedPattern: "docker",
        sections: ["preflight"],
      },
    ],
    memories: [
      {
        id: "mem-1",
        content: "Always check container health after deploy",
        confidence: 0.85,
        category: "process",
        lastAccessed: new Date().toISOString(),
        accessCount: 5,
      },
    ],
    totalSources: 2,
    lookupTimeMs: 42,
    cacheHits: 0,
    ...overrides,
  };
}

function makeConfig(level: EnforcementLevel = EnforcementLevel.CATEGORY) {
  return {
    level,
    categoryRules: new Map<string, EnforcementLevel>([
      ["process", EnforcementLevel.STRICT],
      ["security", EnforcementLevel.STRICT],
      ["credentials", EnforcementLevel.STRICT],
      ["technical", EnforcementLevel.ADVISORY],
      ["general", EnforcementLevel.ADVISORY],
    ]),
    cooldownMs: 5 * 60 * 1000,
    confidenceThresholds: new Map([
      ["critical", 0.8],
      ["routine", 0.5],
    ]),
    emergencyBypass: false,
    maxKnowledgeLength: 4000,
  };
}

describe("EnforcementEngine", () => {
  let engine: EnforcementEngine;

  beforeEach(() => {
    engine = new EnforcementEngine();
  });

  describe("enforcement levels", () => {
    it("does not block when enforcement is DISABLED", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge(),
        makeConfig(EnforcementLevel.DISABLED),
      );
      expect(decision.block).toBe(false);
    });

    it("does not block in ADVISORY mode (but provides reason)", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge(),
        makeConfig(EnforcementLevel.ADVISORY),
      );
      expect(decision.block).toBe(false);
      expect(decision.reason).toBeDefined();
      expect(decision.reason).toContain("Knowledge Available");
    });

    it("blocks in STRICT mode with knowledge present", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge(),
        makeConfig(EnforcementLevel.STRICT),
      );
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain("PRE-ACTION KNOWLEDGE CONSULTATION");
    });

    it("blocks in CATEGORY mode when process memory found (strict category)", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge(), // has category: "process" → maps to STRICT
        makeConfig(EnforcementLevel.CATEGORY),
      );
      expect(decision.block).toBe(true);
    });

    it("does not block in CATEGORY mode with only advisory-level memories", async () => {
      const knowledge = makeKnowledge({
        sopFiles: [],
        memories: [
          {
            id: "mem-2",
            content: "Technical note about docker",
            confidence: 0.6,
            category: "technical", // → ADVISORY level
            lastAccessed: new Date().toISOString(),
            accessCount: 1,
          },
        ],
        totalSources: 1,
      });
      const decision = await engine.shouldBlock(
        makeContext(),
        knowledge,
        makeConfig(EnforcementLevel.CATEGORY),
      );
      expect(decision.block).toBe(false);
    });
  });

  describe("no knowledge → no block", () => {
    it("allows tool call when no knowledge found", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge({ sopFiles: [], memories: [], totalSources: 0 }),
        makeConfig(),
      );
      expect(decision.block).toBe(false);
    });
  });

  describe("cooldown management", () => {
    it("blocks on first call, allows on second within cooldown", async () => {
      const ctx = makeContext();
      const knowledge = makeKnowledge();
      const config = makeConfig(EnforcementLevel.STRICT);

      const first = await engine.shouldBlock(ctx, knowledge, config);
      expect(first.block).toBe(true);

      const second = await engine.shouldBlock(ctx, knowledge, config);
      expect(second.block).toBe(false);
      expect(second.metadata.cooldownActive).toBe(true);
    });

    it("does not trigger cooldown for different contexts", async () => {
      const config = makeConfig(EnforcementLevel.STRICT);

      const d1 = await engine.shouldBlock(
        makeContext({ keywords: ["docker"] }),
        makeKnowledge(),
        config,
      );
      expect(d1.block).toBe(true);

      const d2 = await engine.shouldBlock(
        makeContext({ keywords: ["git"], serviceType: "git" }),
        makeKnowledge({
          sopFiles: [
            {
              label: "Git Ops",
              path: "/sop/git.ai.sop",
              content: "## preflight\nCheck branch",
              priority: 6,
              matchedPattern: "git",
              sections: ["preflight"],
            },
          ],
        }),
        config,
      );
      expect(d2.block).toBe(true);
    });
  });

  describe("emergency bypass", () => {
    it("allows all calls when emergency bypass is active", async () => {
      const config = makeConfig(EnforcementLevel.STRICT);
      config.emergencyBypass = true;

      const decision = await engine.shouldBlock(makeContext(), makeKnowledge(), config);
      expect(decision.block).toBe(false);
      expect(decision.metadata.canBypass).toBe(true);
    });
  });

  describe("bypass tokens", () => {
    it("generates and validates bypass tokens", () => {
      const token = engine.generateBypassToken();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
      expect(engine.validateBypassToken(token)).toBe(true);
      expect(engine.validateBypassToken("invalid-token")).toBe(false);
    });
  });

  describe("metadata", () => {
    it("populates metadata correctly", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge(),
        makeConfig(EnforcementLevel.DISABLED),
      );
      expect(decision.metadata.sopCount).toBe(1);
      expect(decision.metadata.memoryCount).toBe(1);
      expect(decision.metadata.confidenceRange).toEqual([0.85, 0.85]);
      expect(decision.metadata.categories).toContain("process");
      expect(decision.metadata.lookupTimeMs).toBe(42);
    });
  });

  describe("knowledge injection formatting", () => {
    it("formats blocking message with SOP and memory sections", async () => {
      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge(),
        makeConfig(EnforcementLevel.STRICT),
      );
      expect(decision.reason).toContain("Docker Deploy");
      expect(decision.reason).toContain("Check images");
      expect(decision.reason).toContain("container health");
    });

    it("truncates long messages", async () => {
      const longMemories = Array.from({ length: 50 }, (_, i) => ({
        id: `mem-${i}`,
        content: "A".repeat(200),
        confidence: 0.9,
        category: "process",
        lastAccessed: new Date().toISOString(),
        accessCount: 1,
      }));

      const config = makeConfig(EnforcementLevel.STRICT);
      config.maxKnowledgeLength = 500;

      const decision = await engine.shouldBlock(
        makeContext(),
        makeKnowledge({ memories: longMemories, totalSources: 51 }),
        config,
      );
      expect(decision.reason!.length).toBeLessThanOrEqual(510); // small buffer for truncation message
    });
  });
});
