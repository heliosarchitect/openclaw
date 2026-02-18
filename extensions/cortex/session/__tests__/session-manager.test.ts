/**
 * Integration Tests — SessionPersistenceManager
 * Cross-Session State Preservation v2.0.0 | task-004
 *
 * Tests the orchestrator: session start/stop, crash recovery, pin inheritance,
 * credential redaction, force-inherit, and chain traversal.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionPersistenceConfig, WorkingMemoryPin, SessionState } from "../types.js";
import { SessionPersistenceManager } from "../session-manager.js";
import { DEFAULT_SESSION_CONFIG } from "../types.js";

// -------------------------------------------------------------------------
// Mock CortexBridge
// -------------------------------------------------------------------------
function makeMockBridge(sessions: Record<string, unknown>[] = []) {
  const savedSessions: Record<string, unknown>[] = [];

  return {
    savedSessions,
    saveSessionState: vi.fn(async (state: Record<string, unknown>) => {
      const idx = savedSessions.findIndex((s) => s.session_id === state.session_id);
      if (idx >= 0) savedSessions[idx] = state;
      else savedSessions.push({ ...state });
    }),
    getRecentSessions: vi.fn(async (_days: number, _limit: number) => sessions),
    markSessionContinued: vi.fn(async () => {}),
    detectCrashedSessions: vi.fn(async (_id: string) => []),
    recoverCrashedSession: vi.fn(async () => {}),
    getSessionChain: vi.fn(async (id: string, _depth: number) => {
      return sessions.filter((s) => (s as Record<string, unknown>).session_id === id);
    }),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function makeConfig(overrides: Partial<SessionPersistenceConfig> = {}): SessionPersistenceConfig {
  return { ...DEFAULT_SESSION_CONFIG, sessions_dir: "/tmp/test-sessions", ...overrides };
}

function makePriorSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "prior-session-001",
    start_time: new Date(Date.now() - 7200_000).toISOString(),
    end_time: new Date(Date.now() - 3600_000).toISOString(),
    channel: "signal",
    working_memory: [],
    hot_topics: ["augur", "trading", "cortex"],
    active_projects: ["augur-trading"],
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

describe("SessionPersistenceManager", () => {
  // -------------------------------------------------------------------------
  // Cold start (no prior sessions)
  // -------------------------------------------------------------------------
  describe("cold start", () => {
    it("returns empty context when no prior sessions exist", async () => {
      const bridge = makeMockBridge([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(result.preamble).toBeNull();
      expect(result.inheritedPins).toHaveLength(0);
      expect(result.sessionIds).toHaveLength(0);
      expect(result.pendingTaskCount).toBe(0);
    });

    it("writes initial session record with null end_time", async () => {
      const bridge = makeMockBridge([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(bridge.saveSessionState).toHaveBeenCalled();
      const saved = bridge.savedSessions.find((s) => s.session_id === "new-session");
      expect(saved).toBeDefined();
      expect(saved!.end_time).toBeNull();
      expect(saved!.channel).toBe("signal");
    });
  });

  // -------------------------------------------------------------------------
  // Session restoration
  // -------------------------------------------------------------------------
  describe("session restoration", () => {
    it("restores context from a qualifying prior session", async () => {
      const prior = makePriorSession({
        hot_topics: ["augur", "trading"],
        active_projects: ["augur-trading"],
        pending_tasks: [
          {
            task_id: "task-004",
            title: "Session Persistence",
            stage: "build",
            flagged_incomplete: false,
          },
        ],
      });
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [
          { content: "existing pin", pinnedAt: new Date().toISOString(), label: "existing" },
        ],
        async () => {},
      );

      expect(result.preamble).not.toBeNull();
      expect(result.preamble).toContain("SESSION CONTINUITY");
      expect(result.sessionIds).toContain("prior-session-001");
      expect(result.pendingTaskCount).toBe(1);
    });

    it("filters out sessions below relevance threshold", async () => {
      const oldSession = makePriorSession({
        end_time: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(), // 7 days ago
        hot_topics: ["zzz", "aaa"], // no overlap
        pending_tasks: [],
      });
      const bridge = makeMockBridge([oldSession as unknown as Record<string, unknown>]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(result.preamble).toBeNull();
      expect(result.sessionIds).toHaveLength(0);
    });

    it("links new session to best prior session via previous_session_id", async () => {
      const prior = makePriorSession();
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      // The session record should have previous_session_id set
      const saved = bridge.savedSessions.find((s) => s.session_id === "new-session");
      expect(saved?.previous_session_id).toBe("prior-session-001");
    });

    it("marks prior sessions as continued", async () => {
      const prior = makePriorSession();
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(bridge.markSessionContinued).toHaveBeenCalledWith("prior-session-001", "new-session");
    });
  });

  // -------------------------------------------------------------------------
  // Pin inheritance
  // -------------------------------------------------------------------------
  describe("pin inheritance", () => {
    it("inherits pins from best prior session", async () => {
      const prior = makePriorSession({
        working_memory: [
          { content: "Important context", pinnedAt: new Date().toISOString(), label: "ctx" },
          { content: "Another pin", pinnedAt: new Date().toISOString(), label: "pin2" },
        ],
      });
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const savedPins: WorkingMemoryPin[] = [];
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async (pins) => {
          savedPins.push(...pins);
        },
      );

      expect(result.inheritedPins).toHaveLength(2);
      expect(savedPins).toHaveLength(2);
    });

    it("respects 10-pin total cap", async () => {
      const existingPins: WorkingMemoryPin[] = Array.from({ length: 8 }, (_, i) => ({
        content: `Existing ${i}`,
        pinnedAt: new Date().toISOString(),
        label: `existing-${i}`,
      }));
      const prior = makePriorSession({
        working_memory: Array.from({ length: 5 }, (_, i) => ({
          content: `Inherited ${i}`,
          pinnedAt: new Date().toISOString(),
          label: `inherited-${i}`,
        })),
      });
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const savedPins: WorkingMemoryPin[] = [];
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => existingPins,
        async (pins) => {
          savedPins.push(...pins);
        },
      );

      // 8 existing + max 2 inherited = 10 total cap
      expect(result.inheritedPins.length).toBeLessThanOrEqual(2);
    });

    it("respects max_inherited_pins config", async () => {
      const prior = makePriorSession({
        working_memory: Array.from({ length: 10 }, (_, i) => ({
          content: `Pin ${i}`,
          pinnedAt: new Date().toISOString(),
          label: `pin-${i}`,
        })),
      });
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const manager = new SessionPersistenceManager(
        bridge as any,
        makeLogger(),
        makeConfig({ max_inherited_pins: 3 }),
      );

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(result.inheritedPins.length).toBeLessThanOrEqual(3);
    });

    it("deduplicates by label — skips pins with existing labels", async () => {
      const prior = makePriorSession({
        working_memory: [
          { content: "Duplicate", pinnedAt: new Date().toISOString(), label: "existing-label" },
          { content: "Unique", pinnedAt: new Date().toISOString(), label: "new-label" },
        ],
      });
      const bridge = makeMockBridge([prior as unknown as Record<string, unknown>]);
      const savedPins: WorkingMemoryPin[] = [];
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [
          { content: "Existing", pinnedAt: new Date().toISOString(), label: "existing-label" },
        ],
        async (pins) => {
          savedPins.push(...pins);
        },
      );

      // Only the unique pin should be inherited
      expect(result.inheritedPins).toHaveLength(1);
      expect(result.inheritedPins[0].label).toBe("new-label");
    });
  });

  // -------------------------------------------------------------------------
  // Incremental update (agent_end)
  // -------------------------------------------------------------------------
  describe("incremental update", () => {
    it("updates session state incrementally", async () => {
      const bridge = makeMockBridge([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      await manager.onSessionStart(
        "sess-inc",
        "signal",
        async () => [],
        async () => {},
      );
      bridge.saveSessionState.mockClear();

      await manager.updateSessionState({
        hot_topics: ["new-topic"],
        active_projects: ["helios"],
      });

      expect(bridge.saveSessionState).toHaveBeenCalledTimes(1);
      const saved = bridge.saveSessionState.mock.calls[0][0];
      expect(saved.hot_topics).toEqual(["new-topic"]);
      expect(saved.active_projects).toEqual(["helios"]);
      expect(saved.updated_at).toBeDefined();
    });

    it("is a no-op when no session started", async () => {
      const bridge = makeMockBridge([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      // No onSessionStart called
      await manager.updateSessionState({ hot_topics: ["x"] });
      expect(bridge.saveSessionState).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Session end (final capture)
  // -------------------------------------------------------------------------
  describe("session end", () => {
    it("captures final state with end_time", async () => {
      const bridge = makeMockBridge([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      await manager.onSessionStart(
        "sess-end",
        "signal",
        async () => [],
        async () => {},
      );
      bridge.saveSessionState.mockClear();

      await manager.onSessionEnd(
        "sess-end",
        ["augur", "cortex"],
        ["augur-trading"],
        [
          {
            task_id: "task-004",
            title: "Session Persistence",
            stage: "test",
            flagged_incomplete: false,
          },
        ],
        ["mem-001"],
        [],
        async () => [{ content: "Pin data", pinnedAt: new Date().toISOString(), label: "test" }],
      );

      expect(bridge.saveSessionState).toHaveBeenCalled();
      const saved = bridge.saveSessionState.mock.calls[0][0];
      expect(saved.end_time).toBeDefined();
      expect(saved.end_time).not.toBeNull();
      expect(saved.hot_topics).toEqual(["augur", "cortex"]);
      expect(saved.pending_tasks).toHaveLength(1);
    });

    it("redacts credentials from working memory pins", async () => {
      const bridge = makeMockBridge([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      await manager.onSessionStart(
        "sess-redact",
        "signal",
        async () => [],
        async () => {},
      );
      bridge.saveSessionState.mockClear();

      await manager.onSessionEnd("sess-redact", [], [], [], [], [], async () => [
        {
          content: "api_key=sk-abc123def456ghi789jkl012mno345pqr678stu901vwx",
          pinnedAt: new Date().toISOString(),
          label: "secret",
        },
        {
          content: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          pinnedAt: new Date().toISOString(),
          label: "github",
        },
        { content: "Normal pin content", pinnedAt: new Date().toISOString(), label: "normal" },
      ]);

      const saved = bridge.saveSessionState.mock.calls[0][0];
      const pins = saved.working_memory as WorkingMemoryPin[];
      // Credentials should be redacted
      expect(pins[0].content).toContain("[REDACTED]");
      expect(pins[1].content).toContain("[REDACTED]");
      // Normal content should remain
      expect(pins[2].content).toBe("Normal pin content");
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery
  // -------------------------------------------------------------------------
  describe("crash recovery", () => {
    it("detects and recovers crashed sessions on start", async () => {
      const crashed = { session_id: "crashed-session", end_time: null };
      const bridge = makeMockBridge([]);
      bridge.detectCrashedSessions.mockResolvedValue([crashed]);
      const logger = makeLogger();
      const manager = new SessionPersistenceManager(bridge as any, logger, makeConfig());

      await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(bridge.detectCrashedSessions).toHaveBeenCalledWith("new-session");
      expect(bridge.recoverCrashedSession).toHaveBeenCalledWith(
        "crashed-session",
        expect.any(String),
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Recovered"));
    });

    it("handles crash detection failure gracefully", async () => {
      const bridge = makeMockBridge([]);
      bridge.detectCrashedSessions.mockRejectedValue(new Error("DB locked"));
      const logger = makeLogger();
      const manager = new SessionPersistenceManager(bridge as any, logger, makeConfig());

      // Should not throw
      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );
      expect(result.preamble).toBeNull(); // Cold start fallback
    });
  });

  // -------------------------------------------------------------------------
  // Force inherit
  // -------------------------------------------------------------------------
  describe("forceInheritSession", () => {
    it("inherits from a specific session by ID", async () => {
      const target = makePriorSession({
        session_id: "target-session",
        working_memory: [
          { content: "Force-inherited pin", pinnedAt: new Date().toISOString(), label: "forced" },
        ],
        hot_topics: ["forced-topic"],
        pending_tasks: [
          { task_id: "t1", title: "Forced Task", stage: "build", flagged_incomplete: true },
        ],
      });
      const bridge = makeMockBridge([target as unknown as Record<string, unknown>]);
      const savedPins: WorkingMemoryPin[] = [];
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.forceInheritSession(
        "target-session",
        async () => [],
        async (pins) => {
          savedPins.push(...pins);
        },
      );

      expect(result.sessionIds).toContain("target-session");
      expect(result.inheritedPins).toHaveLength(1);
      expect(result.relevanceScores[0]).toBe(1.0);
      expect(result.pendingTaskCount).toBe(1);
    });

    it("returns empty when target session not found", async () => {
      const bridge = makeMockBridge([]);
      bridge.getSessionChain.mockResolvedValue([]);
      const manager = new SessionPersistenceManager(bridge as any, makeLogger(), makeConfig());

      const result = await manager.forceInheritSession(
        "nonexistent",
        async () => [],
        async () => {},
      );

      expect(result.preamble).toBeNull();
      expect(result.inheritedPins).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Fail-open behavior
  // -------------------------------------------------------------------------
  describe("fail-open behavior", () => {
    it("falls back to cold start when restoration throws", async () => {
      const bridge = makeMockBridge([]);
      bridge.getRecentSessions.mockRejectedValue(new Error("DB corruption"));
      const logger = makeLogger();
      const manager = new SessionPersistenceManager(bridge as any, logger, makeConfig());

      const result = await manager.onSessionStart(
        "new-session",
        "signal",
        async () => [],
        async () => {},
      );

      expect(result.preamble).toBeNull();
      expect(result.inheritedPins).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cold start"));
    });
  });
});
