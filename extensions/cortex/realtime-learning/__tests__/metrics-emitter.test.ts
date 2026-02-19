/**
 * Real-Time Learning — Metrics Emitter Tests
 * Task-011: test stage
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RealtimeLearningDB } from "../types.js";
import { MetricsEmitter } from "../metrics/metrics-emitter.js";

describe("MetricsEmitter", () => {
  let db: RealtimeLearningDB;
  let emitter: MetricsEmitter;

  beforeEach(() => {
    db = {
      run: vi.fn(),
      get: vi.fn().mockResolvedValue({ cnt: 0 }),
      all: vi.fn().mockResolvedValue([]),
    };
    emitter = new MetricsEmitter(db);
  });

  it("returns null metrics when no data exists", async () => {
    (db.get as ReturnType<typeof vi.fn>).mockResolvedValue({ cnt: 0 });
    const m = await emitter.compute();
    expect(m.total_failures).toBe(0);
    expect(m.total_propagations).toBe(0);
    expect(m.avg_t2p_seconds).toBeNull();
    expect(m.propagation_completeness_pct).toBeNull();
    expect(m.recurrence_rate_pct).toBeNull();
  });

  it("computes metrics correctly with data", async () => {
    const getResponses = [
      { avg_t2p: 12.5 }, // T2P
      { cnt: 10 }, // total failures
      { cnt: 8 }, // propagated
      { cnt: 10 }, // total events (for recurrence)
      { cnt: 1 }, // recurring
    ];
    let getCall = 0;
    (db.get as ReturnType<typeof vi.fn>).mockImplementation(async () => getResponses[getCall++]);
    (db.all as ReturnType<typeof vi.fn>).mockResolvedValue([
      { type: "TOOL_ERR", cnt: 5 },
      { type: "CORRECT", cnt: 3 },
      { type: "PIPE_FAIL", cnt: 2 },
    ]);

    const m = await emitter.compute();
    expect(m.avg_t2p_seconds).toBe(12.5);
    expect(m.propagation_completeness_pct).toBe(80);
    expect(m.recurrence_rate_pct).toBe(10);
    expect(m.total_failures).toBe(10);
    expect(m.total_propagations).toBe(8);
    expect(m.failures_by_type.TOOL_ERR).toBe(5);
    expect(m.failures_by_type.CORRECT).toBe(3);
    expect(m.failures_by_type.PIPE_FAIL).toBe(2);
    expect(m.failures_by_type.SOP_VIOL).toBe(0);
    expect(m.failures_by_type.TRUST_DEM).toBe(0);
  });

  it("formats report as readable string", async () => {
    const report = await emitter.formatReport();
    expect(report).toContain("Real-Time Learning");
    expect(report).toContain("Total Failures");
    expect(report).toContain("Propagation Completeness");
    expect(report).toContain("Recurrence Rate");
  });

  it("shows N/A for null metrics in report", async () => {
    (db.get as ReturnType<typeof vi.fn>).mockResolvedValue({ cnt: 0 });
    const report = await emitter.formatReport();
    expect(report).toContain("N/A");
  });

  it("lists failure types with counts > 0 in report", async () => {
    const getResponses = [{ avg_t2p: 5.0 }, { cnt: 3 }, { cnt: 2 }, { cnt: 3 }, { cnt: 0 }];
    let getCall = 0;
    (db.get as ReturnType<typeof vi.fn>).mockImplementation(async () => getResponses[getCall++]);
    (db.all as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: "TOOL_ERR", cnt: 3 }]);

    const report = await emitter.formatReport();
    expect(report).toContain("TOOL_ERR: 3");
    expect(report).not.toContain("CORRECT:");
  });
});
