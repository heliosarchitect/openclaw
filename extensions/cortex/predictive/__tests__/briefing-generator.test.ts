/**
 * Unit Tests — BriefingGenerator
 * Predictive Intent v2.1.0 | task-005
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { PredictiveIntentConfig, SourceReading } from "../types.js";
import { BriefingGenerator } from "../briefing-generator.js";

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

function makeReadings(): SourceReading[] {
  return [
    {
      source_id: "augur.trades",
      captured_at: new Date().toISOString(),
      freshness_ms: 600000,
      data: { session_pnl: "+$42.50" },
      available: true,
    },
    {
      source_id: "fleet.health",
      captured_at: new Date().toISOString(),
      freshness_ms: 600000,
      data: { unreachable: [] },
      available: true,
    },
  ];
}

describe("BriefingGenerator", () => {
  let gen: BriefingGenerator;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    gen = new BriefingGenerator(() => makeReadings(), makeConfig(), "test-session");
  });

  describe("checkMorningBrief", () => {
    it("generates morning brief during morning hours", () => {
      const morning = new Date();
      morning.setHours(8, 0, 0, 0);
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(8);

      const insight = gen.checkMorningBrief();
      expect(insight).not.toBeNull();
      expect(insight!.type).toBe("briefing");
      expect(insight!.source_id).toBe("briefing.morning");
      expect(insight!.title).toContain("morning");
    });

    it("returns null outside morning window", () => {
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(14);
      expect(gen.checkMorningBrief()).toBeNull();
    });

    it("suppresses duplicate morning brief", () => {
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(8);
      expect(gen.checkMorningBrief()).not.toBeNull();
      expect(gen.checkMorningBrief()).toBeNull(); // suppressed
    });

    it("returns null when no readings available", () => {
      gen = new BriefingGenerator(() => [], makeConfig(), "test-session");
      vi.spyOn(Date.prototype, "getHours").mockReturnValue(8);
      expect(gen.checkMorningBrief()).toBeNull();
    });
  });

  describe("checkPreSleepBrief", () => {
    it("returns null when not idle long enough", () => {
      gen.recordToolCall(); // recent activity
      expect(gen.checkPreSleepBrief()).toBeNull();
    });

    it("generates brief after idle threshold", () => {
      // Simulate idle: set lastToolCallTime to 2 hours ago
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      // recordToolCall sets lastToolCallTime, so we need to simulate via time mock
      gen.recordToolCall();
      // Override internal state by re-creating with manipulated time
      const config = makeConfig();
      config.briefings.pre_sleep_idle_ms = 1000; // 1 second threshold for test
      gen = new BriefingGenerator(() => makeReadings(), config, "test-session");
      // Wait past threshold
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);

      const insight = gen.checkPreSleepBrief();
      expect(insight).not.toBeNull();
      expect(insight!.source_id).toBe("briefing.pre_sleep");
    });

    it("suppresses duplicate pre-sleep brief", () => {
      const config = makeConfig();
      config.briefings.pre_sleep_idle_ms = 1;
      config.briefings.suppression_window_ms = 14400000;
      gen = new BriefingGenerator(() => makeReadings(), config, "test-session");

      // Need to ensure lastToolCallTime is today but idle threshold is met
      gen.recordToolCall();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000); // 5s later, past 1ms threshold

      const first = gen.checkPreSleepBrief();
      expect(first).not.toBeNull();

      // Second call should be suppressed
      const second = gen.checkPreSleepBrief();
      expect(second).toBeNull();
    });
  });

  describe("generatePipelineBrief", () => {
    it("creates low-urgency briefing on pass", () => {
      const insight = gen.generatePipelineBrief("task-005", "build", "pass");
      expect(insight.type).toBe("briefing");
      expect(insight.urgency).toBe("low");
      expect(insight.actionable).toBe(false);
      expect(insight.title).toContain("passed");
    });

    it("creates high-urgency briefing on fail", () => {
      const insight = gen.generatePipelineBrief("task-005", "test", "fail");
      expect(insight.urgency).toBe("high");
      expect(insight.actionable).toBe(true);
      expect(insight.delivery_channel).toBe("in_session");
      expect(insight.title).toContain("failed");
    });
  });
});
