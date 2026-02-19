import { describe, expect, it } from "vitest";
import type { SourceReading } from "../../predictive/types.js";
import { AnomalyClassifier } from "../anomaly-classifier.js";

const classifier = new AnomalyClassifier();

function makeReading(
  source_id: string,
  data: Record<string, unknown>,
  available = true,
): SourceReading {
  return { source_id, captured_at: new Date().toISOString(), freshness_ms: 60000, data, available };
}

describe("AnomalyClassifier", () => {
  it("returns [] for unavailable reading", () => {
    expect(classifier.classify(makeReading("heal.disk", {}, false))).toEqual([]);
  });

  it("classifies signal_stale", () => {
    const r = makeReading("augur.signals", { signal_stale: true });
    const anomalies = classifier.classify(r);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].anomaly_type).toBe("signal_stale");
    expect(anomalies[0].severity).toBe("high");
  });

  it("classifies phantom_position", () => {
    const r = makeReading("augur.signals", { has_open_position: true, has_live_signal: false });
    const anomalies = classifier.classify(r);
    expect(anomalies.some((a) => a.anomaly_type === "phantom_position")).toBe(true);
  });

  it("classifies fleet_unreachable", () => {
    const r = makeReading("fleet.health", { unreachable: ["radio.fleet.wood"] });
    const anomalies = classifier.classify(r);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].anomaly_type).toBe("fleet_unreachable");
    expect(anomalies[0].target_id).toBe("fleet:radio.fleet.wood");
  });

  it("classifies pipeline_stuck", () => {
    const r = makeReading("pipeline.state", { stuck_task: "task-005" });
    const anomalies = classifier.classify(r);
    expect(anomalies[0].anomaly_type).toBe("pipeline_stuck");
  });

  it("classifies process_dead", () => {
    const r = makeReading("heal.augur_process", { pid_found: false });
    const anomalies = classifier.classify(r);
    expect(anomalies[0].anomaly_type).toBe("process_dead");
    expect(anomalies[0].severity).toBe("critical");
  });

  it("classifies process_zombie", () => {
    const r = makeReading("heal.augur_process", { pid_found: true, zombie: true });
    const anomalies = classifier.classify(r);
    expect(anomalies[0].anomaly_type).toBe("process_zombie");
  });

  it("classifies gateway_unresponsive (consecutive >= 2)", () => {
    const r = makeReading("heal.gateway", { consecutive_failures: 2 });
    expect(classifier.classify(r)[0].anomaly_type).toBe("gateway_unresponsive");
  });

  it("does NOT classify gateway with 1 failure", () => {
    const r = makeReading("heal.gateway", { consecutive_failures: 1 });
    expect(classifier.classify(r)).toHaveLength(0);
  });

  it("classifies db_corruption", () => {
    const r = makeReading("heal.brain_db", { integrity_ok: false });
    expect(classifier.classify(r)[0].anomaly_type).toBe("db_corruption");
    expect(classifier.classify(r)[0].severity).toBe("critical");
  });

  it("classifies disk_pressure vs disk_critical", () => {
    const r1 = makeReading("heal.disk", { mounts: [{ mount: "/", usage_pct: 0.9 }] });
    expect(classifier.classify(r1)[0].anomaly_type).toBe("disk_pressure");

    const r2 = makeReading("heal.disk", { mounts: [{ mount: "/", usage_pct: 0.96 }] });
    expect(classifier.classify(r2)[0].anomaly_type).toBe("disk_critical");
  });

  it("classifies memory_pressure vs memory_critical", () => {
    const r1 = makeReading("heal.memory", { available_mb: 400 });
    expect(classifier.classify(r1)[0].anomaly_type).toBe("memory_pressure");

    const r2 = makeReading("heal.memory", { available_mb: 200 });
    expect(classifier.classify(r2)[0].anomaly_type).toBe("memory_critical");
  });

  it("classifies log_bloat", () => {
    const r = makeReading("heal.log_bloat", { bloated_files: ["/var/log/big.log"] });
    expect(classifier.classify(r)[0].anomaly_type).toBe("log_bloat");
  });

  it("returns [] for healthy readings", () => {
    expect(
      classifier.classify(makeReading("heal.disk", { mounts: [{ mount: "/", usage_pct: 0.5 }] })),
    ).toHaveLength(0);
    expect(classifier.classify(makeReading("heal.memory", { available_mb: 4096 }))).toHaveLength(0);
    expect(classifier.classify(makeReading("heal.brain_db", { integrity_ok: true }))).toHaveLength(
      0,
    );
  });
});
