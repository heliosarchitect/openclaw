/**
 * Real-Time Learning — Recurrence Detector Tests
 * Task-011: test stage
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FailureEvent, RealtimeLearningConfig, RealtimeLearningDeps } from "../types.js";
import { RecurrenceDetector } from "../recurrence/recurrence-detector.js";
import { DEFAULT_REALTIME_LEARNING_CONFIG } from "../types.js";

function makeFailure(overrides: Partial<FailureEvent> = {}): FailureEvent {
  return {
    id: "fail-001",
    detected_at: new Date().toISOString(),
    type: "TOOL_ERR",
    tier: 1,
    source: "exec",
    context: {},
    failure_desc: "ENOENT: no such file",
    root_cause: "wrong_path",
    propagation_status: "pending",
    recurrence_count: 0,
    ...overrides,
  };
}

function createMockDeps(priorRows: unknown[] = []): RealtimeLearningDeps {
  return {
    db: {
      run: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue(priorRows),
    },
    sendSynapse: vi.fn().mockResolvedValue("msg-123"),
    writeMetric: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    repoRoot: "/tmp/test",
  };
}

describe("RecurrenceDetector", () => {
  let detector: RecurrenceDetector;
  let deps: RealtimeLearningDeps;

  beforeEach(() => {
    deps = createMockDeps();
    detector = new RecurrenceDetector(DEFAULT_REALTIME_LEARNING_CONFIG, deps);
  });

  it("returns false when no prior occurrences exist", async () => {
    const result = await detector.check(makeFailure());
    expect(result).toBe(false);
    expect(deps.sendSynapse).not.toHaveBeenCalled();
  });

  it("returns false when root_cause is unknown", async () => {
    const result = await detector.check(makeFailure({ root_cause: "unknown" }));
    expect(result).toBe(false);
  });

  it("returns false when root_cause is missing", async () => {
    const result = await detector.check(makeFailure({ root_cause: undefined }));
    expect(result).toBe(false);
  });

  it("detects recurrence and escalates via Synapse", async () => {
    const priors = [
      { id: "fail-000", detected_at: "2026-02-18T01:00:00Z", propagation_status: "propagated" },
    ];
    deps = createMockDeps(priors);
    detector = new RecurrenceDetector(DEFAULT_REALTIME_LEARNING_CONFIG, deps);

    const result = await detector.check(makeFailure());
    expect(result).toBe(true);
    expect(deps.db.run).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE failure_events"),
      expect.arrayContaining([expect.any(String), "fail-001"]),
    );
    expect(deps.sendSynapse).toHaveBeenCalledWith(
      expect.stringContaining("Recurrence"),
      expect.stringContaining("wrong_path"),
      "urgent",
      "recurrence:wrong_path",
    );
  });

  it("includes prior count in escalation message", async () => {
    const priors = [
      { id: "fail-000", detected_at: "2026-02-18T01:00:00Z", propagation_status: "propagated" },
      { id: "fail-prev", detected_at: "2026-02-17T01:00:00Z", propagation_status: "committed" },
    ];
    deps = createMockDeps(priors);
    detector = new RecurrenceDetector(DEFAULT_REALTIME_LEARNING_CONFIG, deps);

    await detector.check(makeFailure());
    expect(deps.sendSynapse).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("2"),
      "urgent",
      expect.any(String),
    );
  });
});
