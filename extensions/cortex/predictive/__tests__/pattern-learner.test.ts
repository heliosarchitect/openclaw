/**
 * Unit Tests — PatternLearner
 * Predictive Intent v2.1.0 | task-005
 */
import { describe, it, expect, vi } from "vitest";
import type { InsightFeedback, PredictBridgeMethods, PredictiveIntentConfig } from "../types.js";
import { PatternLearner } from "../pattern-learner.js";

function makeBridge(overrides?: Partial<PredictBridgeMethods>): PredictBridgeMethods {
  return {
    saveInsight: vi.fn().mockResolvedValue(undefined),
    updateInsightState: vi.fn().mockResolvedValue(undefined),
    getQueuedInsights: vi.fn().mockResolvedValue([]),
    saveFeedback: vi.fn().mockResolvedValue(undefined),
    getActionRate: vi
      .fn()
      .mockResolvedValue({ action_rate: 0.5, observation_count: 10, rate_halved: false }),
    upsertActionRate: vi.fn().mockResolvedValue(undefined),
    getFeedbackHistory: vi.fn().mockResolvedValue([
      { id: "1" },
      { id: "2" },
      { id: "3" }, // ≥3 observations
    ]),
    getRecentDelivered: vi.fn().mockResolvedValue([]),
    expireStaleInsights: vi.fn().mockResolvedValue(0),
    ...overrides,
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

function makeFeedback(actedOn = true): InsightFeedback {
  return {
    id: "fb-1",
    insight_id: "ins-1",
    insight_type: "alert",
    source_id: "fleet.health",
    urgency_at_delivery: "high",
    delivered_at: new Date().toISOString(),
    channel: "in_session",
    acted_on: actedOn,
    action_type: actedOn ? "implicit" : "ignored",
    latency_ms: actedOn ? 5000 : null,
    session_id: "test-session",
    created_at: new Date().toISOString(),
  };
}

describe("PatternLearner", () => {
  it("creates atom when ≥3 observations and rate ≥ 0.3", async () => {
    const atomCreate = vi.fn().mockResolvedValue("atom-1");
    const atomSearch = vi.fn().mockResolvedValue([]);
    const learner = new PatternLearner(makeBridge(), makeConfig(), atomCreate, atomSearch);

    await learner.analyzeForPattern(makeFeedback());

    expect(atomCreate).toHaveBeenCalledOnce();
    const call = atomCreate.mock.calls[0][0];
    expect(call.subject).toBe("fleet.health");
    expect(call.source).toBe("predictive-intent");
    expect(call.confidence).toBe(0.5);
  });

  it("skips atom creation when existing atom found", async () => {
    const atomCreate = vi.fn().mockResolvedValue("atom-1");
    const atomSearch = vi.fn().mockResolvedValue([{ id: "existing", confidence: 0.8 }]);
    const learner = new PatternLearner(makeBridge(), makeConfig(), atomCreate, atomSearch);

    await learner.analyzeForPattern(makeFeedback());

    expect(atomCreate).not.toHaveBeenCalled();
  });

  it("skips when fewer than 3 observations", async () => {
    const atomCreate = vi.fn();
    const bridge = makeBridge({ getFeedbackHistory: vi.fn().mockResolvedValue([{ id: "1" }]) });
    const learner = new PatternLearner(bridge, makeConfig(), atomCreate);

    await learner.analyzeForPattern(makeFeedback());

    expect(atomCreate).not.toHaveBeenCalled();
  });

  it("skips when action rate < 0.3", async () => {
    const atomCreate = vi.fn();
    const bridge = makeBridge({
      getActionRate: vi.fn().mockResolvedValue({ action_rate: 0.2, observation_count: 10 }),
    });
    const learner = new PatternLearner(bridge, makeConfig(), atomCreate);

    await learner.analyzeForPattern(makeFeedback());

    expect(atomCreate).not.toHaveBeenCalled();
  });

  it("skips non-acted-on feedback", async () => {
    const atomCreate = vi.fn();
    const learner = new PatternLearner(makeBridge(), makeConfig(), atomCreate);

    await learner.analyzeForPattern(makeFeedback(false));

    expect(atomCreate).not.toHaveBeenCalled();
  });

  it("skips when no atomCreate function provided", async () => {
    const learner = new PatternLearner(makeBridge(), makeConfig());
    // Should not throw
    await learner.analyzeForPattern(makeFeedback());
  });

  it("handles bridge errors gracefully", async () => {
    const atomCreate = vi.fn();
    const bridge = makeBridge({
      getFeedbackHistory: vi.fn().mockRejectedValue(new Error("db error")),
    });
    const learner = new PatternLearner(bridge, makeConfig(), atomCreate);

    // Should not throw
    await learner.analyzeForPattern(makeFeedback());
    expect(atomCreate).not.toHaveBeenCalled();
  });
});
