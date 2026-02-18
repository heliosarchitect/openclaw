/**
 * Unit Tests — UrgencyScorer
 * Predictive Intent v2.1.0 | task-005
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  Insight,
  PredictiveIntentConfig,
  SourceReading,
  UrgencyScoringInputs,
} from "../types.js";
import {
  computeTimeSensitivity,
  computeCrossSourceConfirmation,
  assignChannel,
  scoreInsight,
} from "../urgency-scorer.js";

// ── Helpers ──────────────────────────────────────────

function makeConfig(overrides?: Partial<PredictiveIntentConfig>): PredictiveIntentConfig {
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
    ...overrides,
  };
}

function makeInsight(overrides?: Partial<Insight>): Insight {
  return {
    id: "test-id",
    type: "anomaly",
    source_id: "augur.signals",
    title: "Test",
    body: "Test body",
    urgency: "low",
    urgency_score: 0,
    confidence: 0.8,
    actionable: true,
    expires_at: null,
    generated_at: new Date().toISOString(),
    state: "generated",
    delivery_channel: null,
    delivered_at: null,
    session_id: "test-session",
    schema_version: 1,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

// ── computeTimeSensitivity ──────────────────────────

describe("computeTimeSensitivity", () => {
  it("returns 0.0 for null (no expiry)", () => {
    expect(computeTimeSensitivity(null)).toBe(0.0);
  });

  it("returns 1.0 for already expired", () => {
    const past = new Date(Date.now() - 60000).toISOString();
    expect(computeTimeSensitivity(past)).toBe(1.0);
  });

  it("returns 1.0 for ≤15 minutes remaining", () => {
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(computeTimeSensitivity(soon)).toBe(1.0);
  });

  it("returns 0.0 for ≥24 hours remaining", () => {
    const far = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();
    expect(computeTimeSensitivity(far)).toBe(0.0);
  });

  it("returns value between 0 and 1 for mid-range", () => {
    const mid = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12h
    const result = computeTimeSensitivity(mid);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });
});

// ── computeCrossSourceConfirmation ──────────────────

describe("computeCrossSourceConfirmation", () => {
  it("returns 0.0 for no other sources", () => {
    expect(computeCrossSourceConfirmation("augur.signals", [])).toBe(0.0);
  });

  it("returns 0.0 when only self is present", () => {
    const readings: SourceReading[] = [
      {
        source_id: "augur.signals",
        captured_at: new Date().toISOString(),
        freshness_ms: 120000,
        data: {},
        available: true,
      },
    ];
    expect(computeCrossSourceConfirmation("augur.signals", readings)).toBe(0.0);
  });

  it("returns 1.0 when all other sources are fresh", () => {
    const readings: SourceReading[] = [
      {
        source_id: "augur.signals",
        captured_at: new Date().toISOString(),
        freshness_ms: 120000,
        data: {},
        available: true,
      },
      {
        source_id: "fleet.health",
        captured_at: new Date().toISOString(),
        freshness_ms: 600000,
        data: {},
        available: true,
      },
      {
        source_id: "git.activity",
        captured_at: new Date().toISOString(),
        freshness_ms: 1200000,
        data: {},
        available: true,
      },
    ];
    expect(computeCrossSourceConfirmation("augur.signals", readings)).toBe(1.0);
  });

  it("excludes unavailable sources from ratio", () => {
    const readings: SourceReading[] = [
      {
        source_id: "fleet.health",
        captured_at: new Date().toISOString(),
        freshness_ms: 600000,
        data: {},
        available: false,
      },
    ];
    expect(computeCrossSourceConfirmation("augur.signals", readings)).toBe(0.0);
  });

  it("returns fractional value for mixed staleness", () => {
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const readings: SourceReading[] = [
      {
        source_id: "fleet.health",
        captured_at: new Date().toISOString(),
        freshness_ms: 600000,
        data: {},
        available: true,
      },
      {
        source_id: "git.activity",
        captured_at: staleTime,
        freshness_ms: 60000,
        data: {},
        available: true,
      }, // stale
    ];
    expect(computeCrossSourceConfirmation("augur.signals", readings)).toBe(0.5);
  });
});

// ── assignChannel ───────────────────────────────────

describe("assignChannel", () => {
  it("critical → signal regardless of focus", () => {
    expect(assignChannel("critical", false)).toBe("signal");
    expect(assignChannel("critical", true)).toBe("signal");
  });

  it("high → in_session normally, synapse during focus", () => {
    expect(assignChannel("high", false)).toBe("in_session");
    expect(assignChannel("high", true)).toBe("synapse");
  });

  it("medium → in_session normally, preamble during focus", () => {
    expect(assignChannel("medium", false)).toBe("in_session");
    expect(assignChannel("medium", true)).toBe("preamble");
  });

  it("low → preamble always", () => {
    expect(assignChannel("low", false)).toBe("preamble");
    expect(assignChannel("low", true)).toBe("preamble");
  });
});

// ── scoreInsight ────────────────────────────────────

describe("scoreInsight", () => {
  const config = makeConfig();

  it("applies weighted formula correctly", () => {
    const insight = makeInsight();
    const inputs: UrgencyScoringInputs = {
      time_sensitivity: 1.0,
      financial_impact: 1.0,
      historical_action_rate: 1.0,
      cross_source_confirmation: 1.0,
    };
    const result = scoreInsight(insight, inputs, config);
    // 1.0*0.4 + 1.0*0.3 + 1.0*0.2 + 1.0*0.1 = 1.0
    expect(result.score).toBeCloseTo(1.0);
    expect(result.tier).toBe("critical");
    expect(result.channel).toBe("signal");
  });

  it("all-zero inputs → low tier", () => {
    const inputs: UrgencyScoringInputs = {
      time_sensitivity: 0,
      financial_impact: 0,
      historical_action_rate: 0,
      cross_source_confirmation: 0,
    };
    const result = scoreInsight(makeInsight(), inputs, config);
    expect(result.score).toBeCloseTo(0);
    expect(result.tier).toBe("low");
  });

  it("score at high threshold → high tier", () => {
    // Need score ≥ 0.60
    const inputs: UrgencyScoringInputs = {
      time_sensitivity: 1.0, // 0.4
      financial_impact: 0.7, // 0.21
      historical_action_rate: 0, // 0
      cross_source_confirmation: 0, // 0
    };
    const result = scoreInsight(makeInsight(), inputs, config);
    expect(result.score).toBeCloseTo(0.61);
    expect(result.tier).toBe("high");
  });

  it("clamps score to [0, 1]", () => {
    const inputs: UrgencyScoringInputs = {
      time_sensitivity: 2.0,
      financial_impact: 2.0,
      historical_action_rate: 2.0,
      cross_source_confirmation: 2.0,
    };
    const result = scoreInsight(makeInsight(), inputs, config);
    expect(result.score).toBe(1.0);
  });

  it("sets state to scored on output insight", () => {
    const inputs: UrgencyScoringInputs = {
      time_sensitivity: 0.5,
      financial_impact: 0.5,
      historical_action_rate: 0.5,
      cross_source_confirmation: 0.5,
    };
    const result = scoreInsight(makeInsight(), inputs, config);
    expect(result.insight.state).toBe("scored");
  });

  it("focus mode routes high → synapse", () => {
    const inputs: UrgencyScoringInputs = {
      time_sensitivity: 1.0,
      financial_impact: 0.7,
      historical_action_rate: 0,
      cross_source_confirmation: 0,
    };
    const result = scoreInsight(makeInsight(), inputs, config, true);
    expect(result.tier).toBe("high");
    expect(result.channel).toBe("synapse");
  });
});
