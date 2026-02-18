/**
 * Unit Tests — FeedbackTracker
 * Predictive Intent v2.1.0 | task-005
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Insight, PredictBridgeMethods, PredictiveIntentConfig } from "../types.js";
import { FeedbackTracker } from "../feedback-tracker.js";

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

function makeDeliveredInsight(sourceId = "fleet.health"): Insight {
  return {
    id: `insight-${Math.random().toString(36).slice(2)}`,
    type: "alert",
    source_id: sourceId,
    title: "Test",
    body: "Test body",
    urgency: "high",
    urgency_score: 0.7,
    confidence: 0.8,
    actionable: true,
    expires_at: null,
    generated_at: new Date().toISOString(),
    state: "delivered",
    delivery_channel: "in_session",
    delivered_at: new Date().toISOString(),
    session_id: "test-session",
    schema_version: 1,
  };
}

describe("FeedbackTracker", () => {
  let tracker: FeedbackTracker;
  let bridge: PredictBridgeMethods;

  beforeEach(() => {
    bridge = makeBridge();
    tracker = new FeedbackTracker(bridge, makeConfig());
  });

  describe("checkImplicitAction", () => {
    it("detects implicit action via keyword match in tool args", async () => {
      const insight = makeDeliveredInsight("fleet.health");
      tracker.onInsightDelivered(insight);

      await tracker.checkImplicitAction(
        "exec",
        { command: "ssh radio.fleet.wood hostname" },
        [insight],
        "test-session",
      );

      expect(bridge.saveFeedback).toHaveBeenCalledOnce();
      const feedback = (bridge.saveFeedback as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(feedback.action_type).toBe("implicit");
      expect(feedback.acted_on).toBe(true);
    });

    it("ignores when no keyword match", async () => {
      const insight = makeDeliveredInsight("fleet.health");
      tracker.onInsightDelivered(insight);

      await tracker.checkImplicitAction(
        "exec",
        { command: "git status" },
        [insight],
        "test-session",
      );

      expect(bridge.saveFeedback).not.toHaveBeenCalled();
    });

    it("ignores insight outside action window", async () => {
      const insight = makeDeliveredInsight("fleet.health");
      // Don't call onInsightDelivered — no delivery timestamp recorded
      await tracker.checkImplicitAction(
        "exec",
        { command: "ssh check fleet" },
        [insight],
        "test-session",
      );

      expect(bridge.saveFeedback).not.toHaveBeenCalled();
    });

    it("does not double-act on already acted_on insight", async () => {
      const insight = makeDeliveredInsight("fleet.health");
      insight.state = "acted_on";
      tracker.onInsightDelivered(insight);

      await tracker.checkImplicitAction(
        "exec",
        { command: "ssh check fleet host" },
        [insight],
        "test-session",
      );

      expect(bridge.saveFeedback).not.toHaveBeenCalled();
    });
  });

  describe("checkExplicitAction", () => {
    it("detects acknowledgment phrase", async () => {
      const insight = makeDeliveredInsight();
      tracker.onInsightDelivered(insight);

      await tracker.checkExplicitAction("Got it, I'll check the fleet.", [insight], "test-session");

      expect(bridge.saveFeedback).toHaveBeenCalledOnce();
      const feedback = (bridge.saveFeedback as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(feedback.action_type).toBe("explicit");
    });

    it("ignores non-acknowledgment text", async () => {
      const insight = makeDeliveredInsight();
      tracker.onInsightDelivered(insight);

      await tracker.checkExplicitAction("What is the weather?", [insight], "test-session");

      expect(bridge.saveFeedback).not.toHaveBeenCalled();
    });
  });

  describe("expireUnacted", () => {
    it("marks delivered insights as ignored after action window", async () => {
      const insight = makeDeliveredInsight();
      // Simulate delivery 11 minutes ago (outside 10min window)
      const oldTime = Date.now() - 11 * 60 * 1000;
      // Access private map via onInsightDelivered + time manipulation
      vi.spyOn(Date, "now").mockReturnValueOnce(oldTime);
      tracker.onInsightDelivered(insight);
      vi.restoreAllMocks();

      await tracker.expireUnacted([insight], "test-session");

      expect(bridge.saveFeedback).toHaveBeenCalledOnce();
      const feedback = (bridge.saveFeedback as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(feedback.action_type).toBe("ignored");
      expect(feedback.acted_on).toBe(false);
    });
  });

  describe("action rate updates", () => {
    it("increases rate on acted_on", async () => {
      const insight = makeDeliveredInsight("fleet.health");
      tracker.onInsightDelivered(insight);

      await tracker.checkExplicitAction("ok", [insight], "test-session");

      expect(bridge.upsertActionRate).toHaveBeenCalledWith(
        "fleet.health",
        "alert",
        0.6, // 0.5 + 0.1
        11, // 10 + 1
        false, // not halved
      );
    });

    it("decreases rate on ignored", async () => {
      const insight = makeDeliveredInsight("fleet.health");
      const oldTime = Date.now() - 11 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValueOnce(oldTime);
      tracker.onInsightDelivered(insight);
      vi.restoreAllMocks();

      await tracker.expireUnacted([insight], "test-session");

      expect(bridge.upsertActionRate).toHaveBeenCalledWith(
        "fleet.health",
        "alert",
        0.45, // 0.5 - 0.05
        11,
        false,
      );
    });

    it("triggers rate halving when below threshold with enough observations", async () => {
      (bridge.getActionRate as ReturnType<typeof vi.fn>).mockResolvedValue({
        action_rate: 0.08,
        observation_count: 25,
        rate_halved: false,
      });

      const insight = makeDeliveredInsight("fleet.health");
      const oldTime = Date.now() - 11 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValueOnce(oldTime);
      tracker.onInsightDelivered(insight);
      vi.restoreAllMocks();

      await tracker.expireUnacted([insight], "test-session");

      expect(bridge.upsertActionRate).toHaveBeenCalledWith(
        "fleet.health",
        "alert",
        0.03, // 0.08 - 0.05
        26,
        true, // halved!
      );
    });
  });
});
