/**
 * Unit Tests — PreambleInjector
 * Cross-Session State Preservation v2.0.0 | task-004
 *
 * Tests preamble formatting: pending tasks, active projects, hot topics, pin count.
 */
import { describe, it, expect } from "vitest";
import type { SessionState } from "../types.js";
import { PreambleInjector } from "../preamble-injector.js";

// -------------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------------
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "sess-001",
    start_time: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    end_time: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
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
    relevance_score: 0.8,
    ...overrides,
  };
}

describe("PreambleInjector", () => {
  const injector = new PreambleInjector();

  // -------------------------------------------------------------------------
  // Null / empty cases
  // -------------------------------------------------------------------------
  describe("null / empty cases", () => {
    it("returns null for empty sessions array", () => {
      expect(injector.format([], 0)).toBeNull();
    });

    it("returns null when session has no topics, projects, tasks, and no pins", () => {
      const session = makeSession({
        hot_topics: [],
        active_projects: [],
        pending_tasks: [],
      });
      // Only header would be generated — not enough content
      expect(injector.format([session], 0)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Header line
  // -------------------------------------------------------------------------
  describe("header line", () => {
    it("includes session count in header", () => {
      const sessions = [
        makeSession({ hot_topics: ["augur"] }),
        makeSession({ hot_topics: ["cortex"], session_id: "sess-002" }),
      ];
      const preamble = injector.format(sessions, 0);
      expect(preamble).toContain("inherited from 2 prior session(s)");
    });

    it("uses singular 'session(s)' for single session", () => {
      const session = makeSession({ hot_topics: ["augur"] });
      const preamble = injector.format([session], 0);
      expect(preamble).toContain("inherited from 1 prior session(s)");
    });
  });

  // -------------------------------------------------------------------------
  // Pending tasks section
  // -------------------------------------------------------------------------
  describe("pending tasks section", () => {
    it("includes PENDING TASKS header when tasks exist", () => {
      const session = makeSession({
        pending_tasks: [
          {
            task_id: "task-004",
            title: "Session Persistence",
            stage: "test",
            flagged_incomplete: true,
          },
        ],
      });
      const preamble = injector.format([session], 0);
      expect(preamble).toContain("PENDING TASKS:");
      expect(preamble).toContain("[task-004]");
      expect(preamble).toContain("Session Persistence");
      expect(preamble).toContain("last stage: test");
    });

    it("deduplicates tasks by task_id across multiple sessions", () => {
      const sharedTask = {
        task_id: "task-004",
        title: "Session Persistence",
        stage: "test",
        flagged_incomplete: true,
      };
      const sessions = [
        makeSession({ pending_tasks: [sharedTask] }),
        makeSession({
          pending_tasks: [
            sharedTask,
            {
              task_id: "task-005",
              title: "Predictive",
              stage: "backlog",
              flagged_incomplete: false,
            },
          ],
          session_id: "sess-002",
        }),
      ];
      const preamble = injector.format(sessions, 0);

      // task-004 should appear exactly once
      const taskMatches = (preamble ?? "").match(/\[task-004\]/g) ?? [];
      expect(taskMatches).toHaveLength(1);
      // task-005 should also be present
      expect(preamble).toContain("[task-005]");
    });

    it("does not include PENDING TASKS header when no tasks", () => {
      const session = makeSession({ hot_topics: ["augur"], pending_tasks: [] });
      const preamble = injector.format([session], 0);
      expect(preamble).not.toContain("PENDING TASKS:");
    });

    it("includes days-ago calculation for tasks", () => {
      const session = makeSession({
        end_time: new Date(Date.now() - 86_400_000).toISOString(), // 1 day ago
        pending_tasks: [
          { task_id: "task-x", title: "Old Task", stage: "build", flagged_incomplete: true },
        ],
      });
      const preamble = injector.format([session], 0);
      // Should say "1d ago" roughly
      expect(preamble).toMatch(/\d+d ago/);
    });
  });

  // -------------------------------------------------------------------------
  // Active projects section
  // -------------------------------------------------------------------------
  describe("active projects section", () => {
    it("includes ACTIVE PROJECTS when projects exist", () => {
      const session = makeSession({ active_projects: ["augur-trading", "helios"] });
      const preamble = injector.format([session], 0);
      expect(preamble).toContain("ACTIVE PROJECTS:");
      expect(preamble).toContain("augur-trading");
      expect(preamble).toContain("helios");
    });

    it("deduplicates projects across sessions", () => {
      const sessions = [
        makeSession({ active_projects: ["augur-trading", "helios"] }),
        makeSession({ active_projects: ["helios", "cortex"], session_id: "sess-002" }),
      ];
      const preamble = injector.format(sessions, 0) ?? "";
      // helios should appear once in the projects list
      const projectLine = preamble.split("\n").find((l) => l.startsWith("ACTIVE PROJECTS:")) ?? "";
      const heliosCount = (projectLine.match(/helios/g) ?? []).length;
      expect(heliosCount).toBe(1);
    });

    it("omits ACTIVE PROJECTS section when empty", () => {
      const session = makeSession({ hot_topics: ["augur"], active_projects: [] });
      const preamble = injector.format([session], 0);
      expect(preamble).not.toContain("ACTIVE PROJECTS:");
    });
  });

  // -------------------------------------------------------------------------
  // Hot topics section
  // -------------------------------------------------------------------------
  describe("hot topics section", () => {
    it("includes HOT TOPICS from highest-scoring session", () => {
      const sessions = [
        makeSession({ hot_topics: ["augur", "trading", "cortex"], relevance_score: 0.9 }),
        makeSession({
          hot_topics: ["wems", "weather"],
          relevance_score: 0.5,
          session_id: "sess-002",
        }),
      ];
      const preamble = injector.format(sessions, 0);
      expect(preamble).toContain("HOT TOPICS:");
      expect(preamble).toContain("augur");
      // Topics from second session should not dominate
    });

    it("limits hot topics to first 10 from best session", () => {
      const topics = Array.from({ length: 20 }, (_, i) => `topic${i}`);
      const session = makeSession({ hot_topics: topics });
      const preamble = injector.format([session], 0) ?? "";
      const topicLine = preamble.split("\n").find((l) => l.startsWith("HOT TOPICS:")) ?? "";
      // Only first 10 topics should appear
      for (let i = 0; i < 10; i++) {
        expect(topicLine).toContain(`topic${i}`);
      }
      for (let i = 10; i < 20; i++) {
        expect(topicLine).not.toContain(`topic${i}`);
      }
    });

    it("omits HOT TOPICS section when empty", () => {
      const session = makeSession({ active_projects: ["augur"], hot_topics: [] });
      const preamble = injector.format([session], 0);
      expect(preamble).not.toContain("HOT TOPICS:");
    });
  });

  // -------------------------------------------------------------------------
  // Working memory / pin inheritance
  // -------------------------------------------------------------------------
  describe("working memory pin count", () => {
    it("includes pin restoration message when pins > 0", () => {
      const session = makeSession({ hot_topics: ["augur"] });
      const preamble = injector.format([session], 3);
      expect(preamble).toContain("WORKING MEMORY RESTORED: 3 pins inherited");
    });

    it("omits pin restoration message when 0 pins", () => {
      const session = makeSession({ hot_topics: ["augur"] });
      const preamble = injector.format([session], 0);
      expect(preamble).not.toContain("WORKING MEMORY RESTORED");
    });

    it("shows correct pin count for 1 pin", () => {
      const session = makeSession({ hot_topics: ["augur"] });
      const preamble = injector.format([session], 1);
      expect(preamble).toContain("1 pins inherited");
    });
  });

  // -------------------------------------------------------------------------
  // SESSION CONTINUITY tag
  // -------------------------------------------------------------------------
  describe("SESSION CONTINUITY tag", () => {
    it("starts with SESSION CONTINUITY marker", () => {
      const session = makeSession({ hot_topics: ["augur"] });
      const preamble = injector.format([session], 0);
      expect(preamble).toMatch(/^\[SESSION CONTINUITY/);
    });
  });

  // -------------------------------------------------------------------------
  // Full preamble integration
  // -------------------------------------------------------------------------
  describe("full preamble", () => {
    it("generates complete preamble with all sections", () => {
      const session = makeSession({
        hot_topics: ["augur", "trading", "cortex"],
        active_projects: ["augur-trading", "helios"],
        pending_tasks: [
          {
            task_id: "task-004",
            title: "Session Persistence",
            stage: "test",
            flagged_incomplete: true,
          },
          {
            task_id: "task-005",
            title: "Predictive Intent",
            stage: "backlog",
            flagged_incomplete: false,
          },
        ],
      });
      const preamble = injector.format([session], 2);

      expect(preamble).toContain("SESSION CONTINUITY");
      expect(preamble).toContain("PENDING TASKS:");
      expect(preamble).toContain("ACTIVE PROJECTS:");
      expect(preamble).toContain("HOT TOPICS:");
      expect(preamble).toContain("WORKING MEMORY RESTORED");
    });
  });
});
