/**
 * Unit Tests — ContextScorer
 * Cross-Session State Preservation v2.0.0 | task-004
 *
 * Tests relevance scoring: recency (40%) + topic overlap (35%) + pending tasks (25%)
 */
import { describe, it, expect } from "vitest";
import type { SessionState } from "../types.js";
import { calculateRelevanceScore } from "../context-scorer.js";

// -------------------------------------------------------------------------
// Test fixture builder
// -------------------------------------------------------------------------
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "test-session-id",
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    channel: "signal",
    working_memory: [],
    hot_topics: [],
    active_projects: [],
    pending_tasks: [],
    recent_learnings: [],
    confidence_updates: [],
    sop_interactions: [],
    previous_session_id: null,
    continued_by: null,
    crash_recovered: false,
    schema_version: 1,
    ...overrides,
  };
}

describe("calculateRelevanceScore", () => {
  // -------------------------------------------------------------------------
  // Score bounds
  // -------------------------------------------------------------------------
  describe("score bounds", () => {
    it("returns a score in [0, 1] for fresh session with perfect overlap", () => {
      const session = makeSession({ hot_topics: ["augur", "trading"] });
      const score = calculateRelevanceScore(session, ["augur", "trading"], 0);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("returns 0 for session 7+ days old with no overlap and no tasks", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 168);
      // recency=0, topicOverlap=0 (both empty → union=0), pendingWeight=0
      expect(score).toBe(0);
    });

    it("returns score near 1.0 for fresh session with full overlap and pending tasks", () => {
      const topics = ["helios", "cortex", "session"];
      const session = makeSession({
        hot_topics: topics,
        pending_tasks: [
          { task_id: "t1", title: "T1", stage: "build", flagged_incomplete: true },
          { task_id: "t2", title: "T2", stage: "test", flagged_incomplete: false },
          { task_id: "t3", title: "T3", stage: "deploy", flagged_incomplete: true },
          { task_id: "t4", title: "T4", stage: "backlog", flagged_incomplete: false },
        ],
      });
      const score = calculateRelevanceScore(session, topics, 0);
      // recency=1.0*0.4=0.4, topicOverlap=1.0*0.35=0.35, pendingWeight=min(1,4*0.25)=1.0*0.25=0.25
      // total = 1.0
      expect(score).toBeCloseTo(1.0, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Recency component (40% weight)
  // -------------------------------------------------------------------------
  describe("recency component (40% weight)", () => {
    it("recency = 1.0 at 0 hours → contributes 0.4 to score (with no other signals)", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 0);
      // Only recency matters when no topics/keywords/tasks
      // recency=1.0, topicOverlap=0 (empty/empty), pendingWeight=0
      // topicOverlap: union=0 → 0
      expect(score).toBeCloseTo(0.4, 5);
    });

    it("recency = 0.5 at 84 hours (3.5 days)", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 84);
      // recency = max(0, 1 - 84/168) = 0.5 → score = 0.5 * 0.4 = 0.2
      expect(score).toBeCloseTo(0.2, 5);
    });

    it("recency = 0 at 168 hours → no recency contribution", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 168);
      expect(score).toBeCloseTo(0, 5);
    });

    it("recency is floored at 0 (never negative contribution)", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 999);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  // -------------------------------------------------------------------------
  // Topic overlap component (35% weight, Jaccard-like)
  // -------------------------------------------------------------------------
  describe("topic overlap component (35% weight)", () => {
    it("perfect overlap at 0 hours contributes 0.35", () => {
      const topics = ["augur", "trading", "cortex"];
      const session = makeSession({ hot_topics: topics, pending_tasks: [] });
      // Fix hoursElapsed=168 to zero out recency, zero tasks
      const score = calculateRelevanceScore(session, topics, 168);
      // recency=0, topicOverlap=1.0, pendingWeight=0
      // score = 0 + 1.0 * 0.35 + 0 = 0.35
      expect(score).toBeCloseTo(0.35, 5);
    });

    it("no overlap contributes 0 topic component", () => {
      const session = makeSession({ hot_topics: ["aaa", "bbb"], pending_tasks: [] });
      const score = calculateRelevanceScore(session, ["xxx", "yyy"], 168);
      // recency=0, topicOverlap=0 (intersection=0, union=4), pendingWeight=0
      expect(score).toBeCloseTo(0, 5);
    });

    it("50% Jaccard overlap contributes 0.175", () => {
      // session: [A, B, C], current: [A, B, D] → intersection=2, union=4 → 0.5
      const session = makeSession({ hot_topics: ["augur", "cortex", "helios"], pending_tasks: [] });
      const score = calculateRelevanceScore(session, ["augur", "cortex", "wems"], 168);
      // intersection=2, union=4, overlap=0.5 → 0.5 * 0.35 = 0.175
      expect(score).toBeCloseTo(0.175, 4);
    });

    it("topic matching is case-insensitive", () => {
      const session = makeSession({ hot_topics: ["Augur", "CORTEX"], pending_tasks: [] });
      const score = calculateRelevanceScore(session, ["augur", "cortex"], 168);
      expect(score).toBeCloseTo(0.35, 5);
    });

    it("empty session topics and empty keywords → zero topic component", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 168);
      expect(score).toBeCloseTo(0, 5);
    });

    it("empty session topics with non-empty keywords → no overlap, zero topic", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, ["augur"], 168);
      // union = currentSet = {augur}, intersection = 0 → 0/1 = 0
      expect(score).toBeCloseTo(0, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Pending tasks component (25% weight, capped at 4)
  // -------------------------------------------------------------------------
  describe("pending tasks component (25% weight)", () => {
    it("1 pending task contributes 0.25 * 0.25 = 0.0625", () => {
      const session = makeSession({
        hot_topics: [],
        pending_tasks: [{ task_id: "t1", title: "T1", stage: "build", flagged_incomplete: true }],
      });
      const score = calculateRelevanceScore(session, [], 168);
      // pendingWeight = min(1.0, 1 * 0.25) = 0.25
      // score = 0 + 0 + 0.25 * 0.25 = 0.0625
      expect(score).toBeCloseTo(0.0625, 5);
    });

    it("4 pending tasks → pendingWeight = 1.0, contributes full 0.25", () => {
      const tasks = [1, 2, 3, 4].map((i) => ({
        task_id: `t${i}`,
        title: `Task ${i}`,
        stage: "build",
        flagged_incomplete: true,
      }));
      const session = makeSession({ hot_topics: [], pending_tasks: tasks });
      const score = calculateRelevanceScore(session, [], 168);
      expect(score).toBeCloseTo(0.25, 5);
    });

    it("10 pending tasks → pendingWeight capped at 1.0 (same as 4)", () => {
      const tasks = Array.from({ length: 10 }, (_, i) => ({
        task_id: `t${i}`,
        title: `Task ${i}`,
        stage: "build",
        flagged_incomplete: false,
      }));
      const session = makeSession({ hot_topics: [], pending_tasks: tasks });
      const score = calculateRelevanceScore(session, [], 168);
      expect(score).toBeCloseTo(0.25, 5);
    });

    it("zero tasks → no pending task contribution", () => {
      const session = makeSession({ hot_topics: [], pending_tasks: [] });
      const score = calculateRelevanceScore(session, [], 168);
      expect(score).toBeCloseTo(0, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Composite scoring
  // -------------------------------------------------------------------------
  describe("composite scoring", () => {
    it("session with recency + topics + tasks scores higher than one with only recency", () => {
      const rich = makeSession({
        hot_topics: ["cortex", "session"],
        pending_tasks: [{ task_id: "t1", title: "T1", stage: "build", flagged_incomplete: true }],
      });
      const bare = makeSession({ hot_topics: [], pending_tasks: [] });

      const richScore = calculateRelevanceScore(rich, ["cortex", "session"], 10);
      const bareScore = calculateRelevanceScore(bare, ["cortex", "session"], 10);

      expect(richScore).toBeGreaterThan(bareScore);
    });

    it("older session with relevant topics can still beat fresh session with no overlap", () => {
      const relevant = makeSession({
        hot_topics: ["augur", "trading", "helios", "cortex"],
        pending_tasks: [
          { task_id: "t1", title: "T1", stage: "build", flagged_incomplete: true },
          { task_id: "t2", title: "T2", stage: "test", flagged_incomplete: false },
        ],
      });
      const fresh = makeSession({ hot_topics: ["zzz", "aaa"], pending_tasks: [] });

      const keywords = ["augur", "trading", "helios", "cortex"];
      const relevantScore = calculateRelevanceScore(relevant, keywords, 100); // older
      const freshScore = calculateRelevanceScore(fresh, keywords, 0); // newer but no overlap

      expect(relevantScore).toBeGreaterThan(freshScore);
    });
  });
});
