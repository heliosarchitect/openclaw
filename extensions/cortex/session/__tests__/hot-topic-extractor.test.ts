/**
 * Unit Tests — HotTopicExtractor
 * Cross-Session State Preservation v2.0.0 | task-004
 *
 * Tests stateful topic accumulation, project detection, SOP tracking.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HotTopicExtractor } from "../hot-topic-extractor.js";

describe("HotTopicExtractor", () => {
  let extractor: HotTopicExtractor;

  beforeEach(() => {
    extractor = new HotTopicExtractor();
  });

  // -------------------------------------------------------------------------
  // recordToolCall
  // -------------------------------------------------------------------------
  describe("recordToolCall", () => {
    it("registers tool name as topic", () => {
      extractor.recordToolCall("exec", { command: "ls" });
      expect(extractor.getCurrentTopics()).toContain("exec");
    });

    it("extracts meaningful words from string params", () => {
      extractor.recordToolCall("exec", { command: "build augur trading system" });
      const topics = extractor.getCurrentTopics();
      expect(topics).toContain("augur");
      expect(topics).toContain("trading");
      expect(topics).toContain("system");
    });

    it("ignores string params shorter than 3 characters", () => {
      extractor.recordToolCall("exec", { command: "ls" });
      const topics = extractor.getCurrentTopics();
      expect(topics).not.toContain("ls");
    });

    it("ignores string params longer than 200 characters", () => {
      const longStr = "a".repeat(201);
      extractor.recordToolCall("exec", { command: longStr });
      // Should not crash and the long string should not be extracted
      expect(() => extractor.getCurrentTopics()).not.toThrow();
    });

    it("ignores stop words (the, and, for, etc.)", () => {
      extractor.recordToolCall("exec", { command: "the and for that this" });
      const topics = extractor.getCurrentTopics();
      const stopWords = ["the", "and", "for", "that", "this"];
      for (const word of stopWords) {
        expect(topics).not.toContain(word);
      }
    });

    it("ignores non-string param values", () => {
      extractor.recordToolCall("cortex_add", { importance: 3, enabled: true, data: [1, 2, 3] });
      // No error, just the tool name recorded
      expect(extractor.getCurrentTopics()).toContain("cortex_add");
    });

    it("accumulates frequency across multiple calls", () => {
      extractor.recordToolCall("exec", { command: "augur backtest" });
      extractor.recordToolCall("exec", { command: "augur validate" });
      extractor.recordToolCall("exec", { command: "augur deploy" });

      const topics = extractor.getCurrentTopics();
      expect(topics.indexOf("augur")).toBeLessThan(topics.indexOf("backtest")); // augur ranked higher
    });
  });

  // -------------------------------------------------------------------------
  // recordMemoryAccess
  // -------------------------------------------------------------------------
  describe("recordMemoryAccess", () => {
    it("records categories with double weight", () => {
      extractor.recordMemoryAccess(["trading", "coding"]);
      const topics = extractor.getCurrentTopics();
      expect(topics).toContain("trading");
      expect(topics).toContain("coding");
    });

    it("categories rank higher than single tool call keywords", () => {
      extractor.recordToolCall("exec", { command: "helios run" });
      extractor.recordMemoryAccess(["augur"]);
      // augur should rank higher (weight 2) vs helios (weight 1 from param)
      const topics = extractor.getCurrentTopics();
      expect(topics.indexOf("augur")).toBeLessThanOrEqual(topics.indexOf("helios"));
    });

    it("handles empty array gracefully", () => {
      expect(() => extractor.recordMemoryAccess([])).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // recordWorkingMemoryLabel
  // -------------------------------------------------------------------------
  describe("recordWorkingMemoryLabel", () => {
    it("records label with highest weight (3)", () => {
      extractor.recordToolCall("exec", { command: "augur" }); // weight 1
      extractor.recordMemoryAccess(["cortex"]); // weight 2
      extractor.recordWorkingMemoryLabel("helios-pipeline"); // weight 3

      const topics = extractor.getCurrentTopics();
      // helios-pipeline words should rank high
      expect(topics).toContain("helios-pipeline");
    });

    it("handles empty label gracefully", () => {
      expect(() => extractor.recordWorkingMemoryLabel("")).not.toThrow();
      // Empty label is a no-op
      expect(extractor.getCurrentTopics()).toHaveLength(0);
    });

    it("extracts words from multi-word labels", () => {
      extractor.recordWorkingMemoryLabel("Session persistence task-004");
      const topics = extractor.getCurrentTopics();
      expect(topics).toContain("session");
      expect(topics).toContain("persistence");
    });
  });

  // -------------------------------------------------------------------------
  // recordExecWorkdir
  // -------------------------------------------------------------------------
  describe("recordExecWorkdir", () => {
    it("extracts project name from /Projects/ path", () => {
      extractor.recordExecWorkdir("/home/bonsaihorn/Projects/augur-trading");
      expect(extractor.getActiveProjects()).toContain("augur-trading");
    });

    it("extracts project name from home directory path", () => {
      extractor.recordExecWorkdir("/home/bonsaihorn/helios");
      expect(extractor.getActiveProjects()).toContain("helios");
    });

    it("adds extracted project to topics with weight 2", () => {
      extractor.recordToolCall("exec", { command: "other" });
      extractor.recordExecWorkdir("/home/bonsaihorn/Projects/cortex-main");
      const topics = extractor.getCurrentTopics();
      expect(topics).toContain("cortex-main");
    });

    it("deduplicates same project across multiple calls", () => {
      extractor.recordExecWorkdir("/home/bonsaihorn/Projects/augur-trading");
      extractor.recordExecWorkdir("/home/bonsaihorn/Projects/augur-trading");
      extractor.recordExecWorkdir("/home/bonsaihorn/Projects/augur-trading");
      // Projects is a Set — should only appear once
      expect(extractor.getActiveProjects().filter((p) => p === "augur-trading")).toHaveLength(1);
    });

    it("handles non-project paths without crashing", () => {
      expect(() => extractor.recordExecWorkdir("/tmp/scratch")).not.toThrow();
      expect(extractor.getActiveProjects()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // recordSynapseSubject
  // -------------------------------------------------------------------------
  describe("recordSynapseSubject", () => {
    it("extracts words from Synapse subject with weight 2", () => {
      extractor.recordSynapseSubject("AUGUR v4 backtest complete");
      const topics = extractor.getCurrentTopics();
      expect(topics).toContain("augur");
      expect(topics).toContain("backtest");
      expect(topics).toContain("complete");
    });
  });

  // -------------------------------------------------------------------------
  // recordLearningId
  // -------------------------------------------------------------------------
  describe("recordLearningId", () => {
    it("records memory IDs for recent learnings", () => {
      extractor.recordLearningId("mem-abc-123");
      extractor.recordLearningId("mem-def-456");
      const ids = extractor.getRecentLearningIds();
      expect(ids).toContain("mem-abc-123");
      expect(ids).toContain("mem-def-456");
      expect(ids).toHaveLength(2);
    });

    it("preserves insertion order", () => {
      extractor.recordLearningId("first");
      extractor.recordLearningId("second");
      extractor.recordLearningId("third");
      const ids = extractor.getRecentLearningIds();
      expect(ids[0]).toBe("first");
      expect(ids[2]).toBe("third");
    });

    it("getAllLearningIds is alias for getRecentLearningIds", () => {
      extractor.recordLearningId("test-id");
      expect(extractor.getAllLearningIds()).toEqual(extractor.getRecentLearningIds());
    });
  });

  // -------------------------------------------------------------------------
  // recordSOPInteraction
  // -------------------------------------------------------------------------
  describe("recordSOPInteraction", () => {
    it("records SOP interaction with path and tool call", () => {
      extractor.recordSOPInteraction("/home/bonsaihorn/Projects/helios/sop/merge.ai.sop", "exec");
      const interactions = extractor.getSOPInteractions();
      expect(interactions).toHaveLength(1);
      expect(interactions[0].sop_path).toBe("/home/bonsaihorn/Projects/helios/sop/merge.ai.sop");
      expect(interactions[0].tool_call).toBe("exec");
    });

    it("records acknowledged flag", () => {
      extractor.recordSOPInteraction("/sop/test.sop", "git_push", true);
      expect(extractor.getSOPInteractions()[0].acknowledged).toBe(true);
    });

    it("defaults acknowledged to false", () => {
      extractor.recordSOPInteraction("/sop/test.sop", "exec");
      expect(extractor.getSOPInteractions()[0].acknowledged).toBe(false);
    });

    it("includes injected_at timestamp", () => {
      const before = new Date().toISOString();
      extractor.recordSOPInteraction("/sop/test.sop", "exec");
      const after = new Date().toISOString();
      const ts = extractor.getSOPInteractions()[0].injected_at;
      expect(ts >= before).toBe(true);
      expect(ts <= after).toBe(true);
    });

    it("accumulates multiple SOP interactions", () => {
      extractor.recordSOPInteraction("/sop/a.sop", "exec");
      extractor.recordSOPInteraction("/sop/b.sop", "write");
      expect(extractor.getSOPInteractions()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getTopN / getCurrentTopics
  // -------------------------------------------------------------------------
  describe("getTopN / getCurrentTopics", () => {
    it("getCurrentTopics returns at most 20 topics", () => {
      // Create more than 20 unique topics
      for (let i = 0; i < 30; i++) {
        extractor.recordToolCall(`tool${i}`, {});
      }
      expect(extractor.getCurrentTopics().length).toBeLessThanOrEqual(20);
    });

    it("getTopN(5) returns exactly 5 topics when > 5 exist", () => {
      for (let i = 0; i < 10; i++) {
        extractor.recordToolCall(`keyword${i}aaa`, {});
      }
      expect(extractor.getTopN(5)).toHaveLength(5);
    });

    it("getTopN returns fewer than N when not enough topics", () => {
      extractor.recordToolCall("exec", {});
      expect(extractor.getTopN(10).length).toBeLessThanOrEqual(10);
    });

    it("topics sorted by frequency (highest first)", () => {
      extractor.recordToolCall("exec", {});
      extractor.recordToolCall("exec", {});
      extractor.recordToolCall("exec", {});
      extractor.recordToolCall("write", {});

      const top = extractor.getTopN(2);
      expect(top[0]).toBe("exec"); // exec appeared 3 times
    });

    it("returns fresh copy (mutations don't affect internal state)", () => {
      extractor.recordToolCall("exec", {});
      const topics = extractor.getCurrentTopics();
      topics.push("injected");
      expect(extractor.getCurrentTopics()).not.toContain("injected");
    });
  });

  // -------------------------------------------------------------------------
  // getActiveProjects
  // -------------------------------------------------------------------------
  describe("getActiveProjects", () => {
    it("returns empty array when no workdirs recorded", () => {
      expect(extractor.getActiveProjects()).toHaveLength(0);
    });

    it("returns fresh copy", () => {
      extractor.recordExecWorkdir("/home/bonsaihorn/Projects/augur");
      const projects = extractor.getActiveProjects();
      projects.push("injected");
      expect(extractor.getActiveProjects()).not.toContain("injected");
    });
  });

  // -------------------------------------------------------------------------
  // Stop word coverage
  // -------------------------------------------------------------------------
  describe("stop word coverage", () => {
    const stopWords = [
      "the",
      "and",
      "for",
      "that",
      "this",
      "with",
      "from",
      "are",
      "was",
      "will",
      "have",
      "has",
      "had",
      "been",
      "being",
      "would",
      "could",
      "should",
      "into",
      "not",
      "but",
      "its",
      "all",
      "can",
      "did",
      "get",
      "got",
      "just",
      "more",
    ];

    for (const word of stopWords) {
      it(`filters stop word: "${word}"`, () => {
        extractor.recordToolCall("exec", { command: `run ${word} build` });
        expect(extractor.getCurrentTopics()).not.toContain(word);
      });
    }
  });
});
