/**
 * Real-Time Learning — Integration Tests
 * Full pipeline: detection → classification → propagation
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { RealtimeLearningDB, RealtimeLearningDeps } from "../types.js";
import { RealtimeLearningEngine } from "../index.js";
import { DEFAULT_REALTIME_LEARNING_CONFIG } from "../types.js";

// In-memory mock DB
function createMockDB(): RealtimeLearningDB & { rows: Map<string, Record<string, unknown>[]> } {
  const tables = new Map<string, Record<string, unknown>[]>();

  return {
    rows: tables,
    async run(sql: string, params?: unknown[]) {
      // Handle CREATE TABLE/INDEX silently
      if (sql.trim().startsWith("CREATE")) return;

      // Handle INSERT
      const insertMatch = sql.match(/INSERT INTO (\w+)/i);
      if (insertMatch) {
        const table = insertMatch[1];
        if (!tables.has(table)) tables.set(table, []);
        // Simplified: store params as row
        tables.get(table)!.push({ sql, params: params ?? [] });
        return;
      }

      // Handle UPDATE silently
    },
    async get<T>(sql: string, _params?: unknown[]): Promise<T | null> {
      // Return empty for schema checks
      if (sql.includes("sqlite_master")) return null;
      if (sql.includes("COUNT")) return { cnt: 0 } as T;
      return null;
    },
    async all<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
      return [];
    },
  };
}

describe("RealtimeLearningEngine integration", () => {
  let engine: RealtimeLearningEngine;
  let db: ReturnType<typeof createMockDB>;
  let synapseMessages: Array<{ subject: string; body: string; priority: string }>;
  let metrics: Array<{ task_id: string; stage: string; result: string }>;

  beforeEach(async () => {
    db = createMockDB();
    synapseMessages = [];
    metrics = [];

    const deps: RealtimeLearningDeps = {
      db,
      sendSynapse: async (subject, body, priority) => {
        synapseMessages.push({ subject, body, priority });
        return "msg-123";
      },
      writeMetric: async (_type, data) => {
        metrics.push(data);
      },
      logger: {},
      repoRoot: "/tmp/test-repo",
    };

    engine = new RealtimeLearningEngine(DEFAULT_REALTIME_LEARNING_CONFIG, deps);
    await engine.start();
  });

  it("processes a tool error through the full pipeline", async () => {
    engine.toolMonitor.onToolResult({
      toolName: "exec",
      exitCode: 1,
      error: "ENOENT: no such file or directory /foo/bar",
      sessionId: "test-session",
      toolCallId: "tc1",
    });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 200));

    expect(engine.stats.processed).toBe(1);

    // Check that failure_events was inserted
    const feRows = db.rows.get("failure_events") ?? [];
    expect(feRows.length).toBeGreaterThan(0);

    // Check propagation records were created
    const prRows = db.rows.get("propagation_records") ?? [];
    expect(prRows.length).toBeGreaterThan(0);

    // Check metrics were emitted
    expect(metrics.some((m) => m.task_id === "rtl_failure_processed")).toBe(true);
  });

  it("processes a correction through the pipeline", async () => {
    engine.correctionScanner.recordToolCall({
      toolName: "write",
      toolCallId: "tc2",
    });
    engine.correctionScanner.onUserMessage("that's wrong, should be pnpm not npm");

    await new Promise((r) => setTimeout(r, 200));

    expect(engine.stats.processed).toBe(1);
  });

  it("processes a trust demotion", async () => {
    engine.trustEventRelay.onDemotion({
      milestone: "corrected_significant",
      priorTier: 2,
      reason: "Overwrote config without approval",
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(engine.stats.processed).toBe(1);
  });

  it("processes a pipeline failure", async () => {
    engine.pipelineFailRelay.onPipelineFail({
      taskId: "task-099",
      stage: "build",
      result: "fail",
      message: "TypeScript compilation failed",
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(engine.stats.processed).toBe(1);
  });

  it("reports metrics correctly", async () => {
    const report = await engine.metrics.formatReport();
    expect(report).toContain("Real-Time Learning");
    expect(report).toContain("Total Failures");
  });
});
