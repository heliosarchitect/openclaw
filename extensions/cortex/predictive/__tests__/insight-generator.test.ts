/**
 * Unit Tests — InsightGenerator
 * Predictive Intent v2.1.0 | task-005
 *
 * Tests all 10 source handlers with mock data injection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Insight, PredictiveIntentConfig, SourceReading } from "../types.js";
import { InsightGenerator } from "../insight-generator.js";

// ── Helpers ──────────────────────────────────────────

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

function makeReading(
  sourceId: string,
  data: Record<string, unknown>,
  available = true,
): SourceReading {
  return {
    source_id: sourceId,
    captured_at: new Date().toISOString(),
    freshness_ms: 300000,
    data: { ...data, _session_id: "test-session" },
    available,
  };
}

let gen: InsightGenerator;
let config: PredictiveIntentConfig;

beforeEach(() => {
  gen = new InsightGenerator();
  config = makeConfig();
});

// ── augur.signals ───────────────────────────────────

describe("augur.signals handler", () => {
  it("generates anomaly for stale signals", () => {
    const reading = makeReading("augur.signals", { stale: true, staleness_ms: 600000 });
    const insights = gen.generate(reading, config, []);
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights[0].type).toBe("anomaly");
    expect(insights[0].title).toContain("stale");
  });

  it("generates opportunity for new signal", () => {
    const reading = makeReading("augur.signals", {
      signal: "long",
      symbol: "BTC/USDT",
      strength: "strong",
      confidence: 0.85,
      _prev_signal: "none",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "opportunity")).toBe(true);
  });

  it("skips when signal unchanged", () => {
    const reading = makeReading("augur.signals", {
      signal: "long",
      _prev_signal: "long",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.filter((i) => i.type === "opportunity")).toHaveLength(0);
  });

  it("returns empty for unavailable source", () => {
    const reading = makeReading("augur.signals", {}, false);
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });

  it("deduplicates within window", () => {
    const reading = makeReading("augur.signals", { stale: true, staleness_ms: 600000 });
    const first = gen.generate(reading, config, []);
    expect(first).toHaveLength(1);
    const second = gen.generate(reading, config, first);
    expect(second).toHaveLength(0);
  });
});

// ── augur.trades ────────────────────────────────────

describe("augur.trades handler", () => {
  it("generates anomaly on loss streak ≥ threshold", () => {
    const reading = makeReading("augur.trades", { loss_streak: 4, session_pnl: "-$150" });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "anomaly")).toBe(true);
  });

  it("generates alert on high unrealized PnL", () => {
    const reading = makeReading("augur.trades", {
      open_trades: [{ id: 1 }],
      unrealized_pnl_pct: -0.05,
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "alert")).toBe(true);
  });

  it("no insight for low loss streak", () => {
    const reading = makeReading("augur.trades", { loss_streak: 1 });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });
});

// ── augur.regime ────────────────────────────────────

describe("augur.regime handler", () => {
  it("generates anomaly on regime change", () => {
    const reading = makeReading("augur.regime", {
      regime_changed: true,
      previous_regime: "trending",
      current_regime: "ranging",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("anomaly");
    expect(insights[0].title).toContain("regime changed");
  });

  it("no insight when no regime change", () => {
    const reading = makeReading("augur.regime", { regime_changed: false });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });
});

// ── augur.paper ─────────────────────────────────────

describe("augur.paper handler", () => {
  it("generates anomaly on paper loss streak", () => {
    const reading = makeReading("augur.paper", { loss_streak: 5, win_rate: "40%" });
    const insights = gen.generate(reading, config, []);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("anomaly");
  });
});

// ── fleet.health ────────────────────────────────────

describe("fleet.health handler", () => {
  it("generates alert when hosts unreachable", () => {
    const reading = makeReading("fleet.health", { unreachable: ["radio (192.168.10.179)"] });
    const insights = gen.generate(reading, config, []);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("alert");
    expect(insights[0].title).toContain("unreachable");
  });

  it("no insight when all reachable", () => {
    const reading = makeReading("fleet.health", { unreachable: [] });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });
});

// ── git.activity ────────────────────────────────────

describe("git.activity handler", () => {
  it("generates briefing for recent commits", () => {
    const reading = makeReading("git.activity", {
      commits: [
        { repo: "helios", hash: "abc123", author: "Matthew", message: "feat: add stuff" },
        { repo: "helios", hash: "def456", author: "Matthew", message: "fix: bug" },
      ],
    });
    const insights = gen.generate(reading, config, []);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("briefing");
    expect(insights[0].body).toContain("helios: 2");
  });

  it("no insight for zero commits", () => {
    const reading = makeReading("git.activity", { commits: [] });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });
});

// ── octoprint.jobs ──────────────────────────────────

describe("octoprint.jobs handler", () => {
  it("generates alert on print complete", () => {
    const reading = makeReading("octoprint.jobs", {
      state: "Operational",
      progress: 100,
      prev_state: "Printing",
      filename: "widget.gcode",
      print_time: "2h 30m",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "alert" && i.title.includes("complete"))).toBe(true);
  });

  it("generates anomaly on printer error", () => {
    const reading = makeReading("octoprint.jobs", { state: "Error", error: "Thermal runaway" });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "anomaly")).toBe(true);
  });

  it("generates progress briefing at milestones", () => {
    const reading = makeReading("octoprint.jobs", {
      state: "Printing",
      progress: 52,
      _prev_milestone: 25,
      filename: "part.gcode",
      time_left: "45m",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "briefing" && i.title.includes("50%"))).toBe(true);
  });
});

// ── pipeline.state ──────────────────────────────────

describe("pipeline.state handler", () => {
  it("generates anomaly for stuck pipeline task", () => {
    const reading = makeReading("pipeline.state", {
      stuck_task: "task-005",
      stuck_stage: "build",
      stuck_duration_ms: 7200000,
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "anomaly" && i.title.includes("stuck"))).toBe(true);
  });

  it("generates alert for failed pipeline", () => {
    const reading = makeReading("pipeline.state", {
      failed_task: "task-005",
      failed_stage: "test",
      failed_result: "fail",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "alert")).toBe(true);
  });

  it("generates briefing for stage completion", () => {
    const reading = makeReading("pipeline.state", {
      completed_task: "task-005",
      completed_stage: "build",
    });
    const insights = gen.generate(reading, config, []);
    expect(insights.some((i) => i.type === "briefing")).toBe(true);
  });
});

// ── cortex.session ──────────────────────────────────

describe("cortex.session handler", () => {
  it("generates reminder for pending tasks", () => {
    const reading = makeReading("cortex.session", {
      pending_tasks: ["Fix fleet adapter", "Review PR #42"],
    });
    const insights = gen.generate(reading, config, []);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("reminder");
  });

  it("no insight for empty pending tasks", () => {
    const reading = makeReading("cortex.session", { pending_tasks: [] });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });
});

// ── cortex.atoms ────────────────────────────────────

describe("cortex.atoms handler", () => {
  it("generates pattern insight for relevant atoms", () => {
    const reading = makeReading("cortex.atoms", {
      relevant_patterns: [
        { subject: "augur.signals", consequences: "price movement by 4h", confidence: 0.8 },
      ],
    });
    const insights = gen.generate(reading, config, []);
    expect(insights).toHaveLength(1);
    expect(insights[0].type).toBe("pattern");
  });

  it("no insight for empty patterns", () => {
    const reading = makeReading("cortex.atoms", { relevant_patterns: [] });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });
});

// ── Cross-cutting ───────────────────────────────────

describe("cross-cutting behavior", () => {
  it("unknown source returns empty", () => {
    const reading = makeReading("unknown.source", { foo: "bar" });
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });

  it("handler errors are caught and return empty", () => {
    gen.registerHandler("bad.source", () => {
      throw new Error("boom");
    });
    const reading = makeReading("bad.source", {});
    expect(gen.generate(reading, config, [])).toHaveLength(0);
  });

  it("all insights have valid UUIDs", () => {
    const reading = makeReading("fleet.health", { unreachable: ["host1"] });
    const insights = gen.generate(reading, config, []);
    for (const i of insights) {
      expect(i.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("title is capped at 80 chars", () => {
    const reading = makeReading("augur.signals", {
      stale: true,
      staleness_ms: 600000,
    });
    const insights = gen.generate(reading, config, []);
    for (const i of insights) {
      expect(i.title.length).toBeLessThanOrEqual(80);
    }
  });

  it("body is capped at 500 chars", () => {
    const reading = makeReading("augur.signals", {
      stale: true,
      staleness_ms: 600000,
    });
    const insights = gen.generate(reading, config, []);
    for (const i of insights) {
      expect(i.body.length).toBeLessThanOrEqual(500);
    }
  });
});
