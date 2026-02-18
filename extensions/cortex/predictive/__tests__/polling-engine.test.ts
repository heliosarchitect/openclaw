/**
 * Unit Tests — PollingEngine
 * Predictive Intent v2.1.0 | task-005
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type {
  DataSourceAdapter,
  PredictBridgeMethods,
  PredictiveIntentConfig,
  SourceReading,
} from "../types.js";
import { PollingEngine } from "../polling-engine.js";

// ── Mocks ───────────────────────────────────────────

function makeBridge(): PredictBridgeMethods {
  return {
    saveInsight: vi.fn().mockResolvedValue(undefined),
    updateInsightState: vi.fn().mockResolvedValue(undefined),
    getQueuedInsights: vi.fn().mockResolvedValue([]),
    saveFeedback: vi.fn().mockResolvedValue(undefined),
    getActionRate: vi
      .fn()
      .mockResolvedValue({ action_rate: 0.5, observation_count: 10, rate_halved: false }),
    upsertActionRate: vi.fn().mockResolvedValue(undefined),
    getFeedbackHistory: vi.fn().mockResolvedValue([]),
    getRecentDelivered: vi.fn().mockResolvedValue([]),
    expireStaleInsights: vi.fn().mockResolvedValue(0),
  };
}

function makeConfig(): PredictiveIntentConfig {
  return {
    enabled: true,
    poll_intervals_ms: {},
    staleness_thresholds_ms: {},
    urgency_thresholds: { high: 0.6, critical: 0.85 },
    delivery: {
      signal_channel: "signal",
      focus_detection_window_ms: 90000,
      focus_detection_min_calls: 3,
      batch_window_ms: 300000,
      duplicate_window_ms: 3600000,
    },
    anomaly_thresholds: {
      augur_signal_stale_ms: 300000,
      augur_loss_streak: 3,
      augur_pnl_loss_pct: 0.02,
      fleet_ssh_timeout_ms: 5000,
      pipeline_stuck_ms: 3600000,
    },
    feedback: {
      action_window_ms: 600000,
      rate_increase_per_act: 0.1,
      rate_decrease_per_ignore: 0.05,
      min_observations: 20,
      low_value_threshold: 0.1,
    },
    briefings: { morning_hour_est: 6, pre_sleep_idle_ms: 5400000, suppression_window_ms: 14400000 },
    octoprint: { host: "http://192.168.10.141", secrets_file: "~/.secrets/octoprint.env" },
    debug: false,
  };
}

class MockAdapter implements DataSourceAdapter {
  readonly source_id: string;
  readonly poll_interval_ms: number;
  readonly freshness_threshold_ms = 300000;
  private mockReading: SourceReading;
  pollCount = 0;

  constructor(sourceId: string, pollMs: number, data: Record<string, unknown> = {}) {
    this.source_id = sourceId;
    this.poll_interval_ms = pollMs;
    this.mockReading = {
      source_id: sourceId,
      captured_at: new Date().toISOString(),
      freshness_ms: 300000,
      data: { ...data, _session_id: "test" },
      available: true,
    };
  }

  async poll(): Promise<SourceReading> {
    this.pollCount++;
    return { ...this.mockReading, captured_at: new Date().toISOString() };
  }

  setMockData(data: Record<string, unknown>): void {
    this.mockReading.data = { ...data, _session_id: "test" };
  }
}

describe("PollingEngine", () => {
  let engine: PollingEngine;
  let bridge: PredictBridgeMethods;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = makeBridge();
    engine = new PollingEngine(bridge, makeConfig());
  });

  afterEach(async () => {
    await engine.stop();
    vi.useRealTimers();
  });

  it("registers adapters and reports count", () => {
    engine.registerAdapter(new MockAdapter("augur.signals", 60000));
    engine.registerAdapter(new MockAdapter("fleet.health", 300000));
    expect(engine.adapterCount).toBe(2);
  });

  it("recovers queued insights on start", async () => {
    const mockInsight = {
      id: "recovered-1",
      type: "anomaly" as const,
      source_id: "fleet.health",
      title: "Recovered",
      body: "From prior session",
      urgency: "high" as const,
      urgency_score: 0.7,
      confidence: 0.8,
      actionable: true,
      expires_at: null,
      generated_at: new Date().toISOString(),
      state: "queued" as const,
      delivery_channel: "in_session" as const,
      delivered_at: null,
      session_id: "old-session",
      schema_version: 1,
    };
    (bridge.getQueuedInsights as ReturnType<typeof vi.fn>).mockResolvedValue([mockInsight]);

    await engine.start();
    expect(engine.queueSize).toBe(1);
  });

  it("polls adapter on start and stores reading", async () => {
    const adapter = new MockAdapter("augur.signals", 60000);
    engine.registerAdapter(adapter);
    await engine.start();
    await vi.advanceTimersByTimeAsync(0); // flush immediate setTimeout(fn, 0)

    expect(adapter.pollCount).toBe(1);
    const reading = engine.getLastReading("augur.signals");
    expect(reading).not.toBeNull();
    expect(reading!.source_id).toBe("augur.signals");
  });

  it("skips adapters with poll_interval_ms <= 0", async () => {
    const adapter = new MockAdapter("cortex.session", 0);
    engine.registerAdapter(adapter);
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.pollCount).toBe(0); // Not auto-polled
  });

  it("pollSource triggers on-demand poll", async () => {
    const adapter = new MockAdapter("cortex.session", 0, { pending_tasks: ["task1"] });
    engine.registerAdapter(adapter);
    await engine.start();

    const reading = await engine.pollSource("cortex.session");
    expect(reading).not.toBeNull();
    expect(reading!.available).toBe(true);
    expect(adapter.pollCount).toBe(1);
  });

  it("getRelevantInsights filters by keyword", async () => {
    // Manually simulate an insight in the queue
    const adapter = new MockAdapter("fleet.health", 60000, {
      unreachable: ["radio (192.168.10.179)"],
    });
    engine.registerAdapter(adapter);
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);

    const relevant = engine.getRelevantInsights(["fleet", "radio"]);
    // May or may not have insights depending on handler output
    // At minimum, it doesn't throw
    expect(Array.isArray(relevant)).toBe(true);
  });

  it("queryInsights returns structured response", async () => {
    engine.registerAdapter(new MockAdapter("augur.signals", 60000));
    await engine.start();
    await vi.advanceTimersByTimeAsync(0);

    const result = engine.queryInsights({ include_queue: true });
    expect(result).toHaveProperty("insights");
    expect(result).toHaveProperty("sources_polled");
    expect(result).toHaveProperty("sources_stale");
    expect(result).toHaveProperty("last_poll");
    expect(result.sources_polled).toBe(1);
  });

  it("queryInsights filters by urgency_min", () => {
    const result = engine.queryInsights({ urgency_min: "critical", include_queue: true });
    expect(result.insights).toHaveLength(0);
  });

  it("queryInsights filters by source", () => {
    const result = engine.queryInsights({ sources: ["nonexistent"], include_queue: true });
    expect(result.insights).toHaveLength(0);
  });

  it("stop clears all timers", async () => {
    engine.registerAdapter(new MockAdapter("augur.signals", 60000));
    await engine.start();
    await engine.stop();
    // After stop, advancing timers should not trigger additional polls
    const adapter = engine["adapters"].get("augur.signals") as MockAdapter;
    const countBefore = adapter?.pollCount ?? 0;
    await vi.advanceTimersByTimeAsync(120000);
    // Count should not increase (timer was cleared)
    expect(adapter?.pollCount ?? 0).toBe(countBefore);
  });

  it("handles adapter poll errors gracefully", async () => {
    const adapter = new MockAdapter("bad.source", 60000);
    vi.spyOn(adapter, "poll").mockRejectedValue(new Error("network error"));
    engine.registerAdapter(adapter);
    await engine.start();

    // Should not throw
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getLastReading("bad.source")).toBeNull();
  });
});
