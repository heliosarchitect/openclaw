import { describe, expect, it } from "vitest";
import { KnowledgeDiscovery } from "../../hooks/knowledge-discovery.js";

describe("KnowledgeDiscovery", () => {
  const mockBridge = { searchMemoriesWithConfidence: async () => [] };
  const kd = new KnowledgeDiscovery(mockBridge);

  describe("extractContext", () => {
    it("exec command extracts keywords", async () => {
      const ctx = await kd.extractContext("exec", { command: "git push origin main" });
      expect(ctx.toolName).toBe("exec");
      expect(ctx.keywords).toContain("git");
      expect(ctx.commandType).toBe("git");
    });

    it("exec risk assessment — critical for rm -rf", async () => {
      const ctx = await kd.extractContext("exec", { command: "rm -rf /important" });
      expect(ctx.riskLevel).toBe("critical");
    });

    it("exec risk assessment — high for sudo", async () => {
      const ctx = await kd.extractContext("exec", { command: "sudo systemctl restart" });
      expect(ctx.riskLevel).toBe("high");
    });

    it("exec risk assessment — medium for ssh", async () => {
      const ctx = await kd.extractContext("exec", { command: "ssh radio.fleet.wood" });
      expect(ctx.riskLevel).toBe("medium");
    });

    it("exec risk assessment — low for ls", async () => {
      const ctx = await kd.extractContext("exec", { command: "ls -la" });
      expect(ctx.riskLevel).toBe("low");
    });

    it("nodes tool marks high risk", async () => {
      const ctx = await kd.extractContext("nodes", { action: "run", node: "radio" });
      expect(ctx.riskLevel).toBe("high");
      expect(ctx.keywords).toContain("nodes");
    });

    it("browser tool marks low risk", async () => {
      const ctx = await kd.extractContext("browser", {
        action: "navigate",
        targetUrl: "https://example.com",
      });
      expect(ctx.riskLevel).toBe("low");
      expect(ctx.urlHost).toBe("example.com");
    });

    it("message tool extracts channel", async () => {
      const ctx = await kd.extractContext("message", { action: "send", channel: "discord" });
      expect(ctx.keywords).toContain("discord");
    });

    it("detects project path from command", async () => {
      const ctx = await kd.extractContext("exec", {
        command: "cd ~/Projects/augur-trading && npm test",
      });
      expect(ctx.projectPath).toBe("/Projects/augur-trading");
    });

    it("detects working directory", async () => {
      const ctx = await kd.extractContext("exec", { command: "ls", workdir: "/tmp" });
      expect(ctx.workingDir).toBe("/tmp");
    });

    it("graceful fallback on error", async () => {
      const ctx = await kd.extractContext("exec", { command: undefined as any });
      expect(ctx.toolName).toBe("exec");
      expect(ctx.riskLevel).toBeDefined();
    });
  });

  describe("discoverSOPs", () => {
    it("returns empty array when no patterns match", async () => {
      const ctx = await kd.extractContext("exec", { command: "echo hello" });
      const sops = await kd.discoverSOPs(ctx);
      expect(sops).toEqual([]);
    });

    it("matches docker pattern", async () => {
      const ctx = await kd.extractContext("exec", { command: "docker compose up" });
      const sops = await kd.discoverSOPs(ctx);
      // May return empty if SOP file doesn't exist on disk, but shouldn't throw
      expect(Array.isArray(sops)).toBe(true);
    });
  });

  describe("discoverMemories", () => {
    it("returns empty with null bridge", async () => {
      const kd2 = new KnowledgeDiscovery(null);
      const ctx = await kd2.extractContext("exec", { command: "test" });
      const mems = await kd2.discoverMemories(ctx, 0.5);
      expect(mems).toEqual([]);
    });

    it("returns results from bridge", async () => {
      const bridge = {
        searchMemoriesWithConfidence: async () => [
          {
            id: "m1",
            content: "test",
            confidence: 0.8,
            category: "process",
            last_accessed: new Date().toISOString(),
            access_count: 1,
          },
        ],
      };
      const kd3 = new KnowledgeDiscovery(bridge);
      const ctx = await kd3.extractContext("exec", { command: "deploy augur" });
      const mems = await kd3.discoverMemories(ctx, 0.5);
      expect(mems).toHaveLength(1);
      expect(mems[0].id).toBe("m1");
    });
  });

  describe("parallelLookup", () => {
    it("returns combined results with timeout protection", async () => {
      const ctx = await kd.extractContext("exec", { command: "echo hello" });
      const result = await kd.parallelLookup(ctx, {
        confidenceThreshold: 0.5,
        maxLookupMs: 5000,
        includeCategories: ["process"],
        enableCaching: true,
      });
      expect(result).toHaveProperty("sopFiles");
      expect(result).toHaveProperty("memories");
      expect(result).toHaveProperty("lookupTimeMs");
      expect(result.lookupTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
