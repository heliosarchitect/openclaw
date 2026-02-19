/**
 * Anomaly Classifier — Maps SourceReading → HealthAnomaly[]
 * Cortex v2.2.0
 *
 * Classification rules keyed by source_id. Never throws — returns [] on error.
 */

import { randomUUID } from "node:crypto";
import type { SourceReading } from "../predictive/types.js";
import type { AnomalySeverity, AnomalyType, HealthAnomaly } from "./types.js";

interface ClassificationRule {
  source_pattern: string;
  classify(reading: SourceReading): HealthAnomaly[];
}

function makeAnomaly(
  type: AnomalyType,
  target: string,
  severity: AnomalySeverity,
  sourceId: string,
  details: Record<string, unknown>,
  hint: string,
): HealthAnomaly {
  return {
    id: randomUUID(),
    anomaly_type: type,
    target_id: target,
    severity,
    detected_at: new Date().toISOString(),
    source_id: sourceId,
    details,
    remediation_hint: hint,
  };
}

const RULES: ClassificationRule[] = [
  // AUGUR signals adapter
  {
    source_pattern: "augur.signals",
    classify(r) {
      const anomalies: HealthAnomaly[] = [];
      const d = r.data;
      if (
        d.signal_stale === true ||
        (typeof d.minutes_since_update === "number" && d.minutes_since_update > 5)
      ) {
        anomalies.push(
          makeAnomaly("signal_stale", "augur-signals", "high", r.source_id, d, "rb-restart-augur"),
        );
      }
      if (d.has_open_position && !d.has_live_signal) {
        anomalies.push(
          makeAnomaly(
            "phantom_position",
            "augur-positions",
            "high",
            r.source_id,
            d,
            "rb-clear-phantom",
          ),
        );
      }
      return anomalies;
    },
  },
  // Fleet health adapter
  {
    source_pattern: "fleet.health",
    classify(r) {
      const unreachable = r.data.unreachable as string[] | undefined;
      if (!unreachable || unreachable.length === 0) return [];
      return unreachable.map((host) =>
        makeAnomaly(
          "fleet_unreachable",
          `fleet:${host}`,
          "high",
          r.source_id,
          { host, ...r.data },
          "rb-probe-then-alert",
        ),
      );
    },
  },
  // Pipeline state adapter
  {
    source_pattern: "pipeline.state",
    classify(r) {
      if (!r.data.stuck_task) return [];
      return [
        makeAnomaly(
          "pipeline_stuck",
          `pipeline:${r.data.stuck_task}`,
          "high",
          r.source_id,
          r.data,
          "rb-kick-pipeline",
        ),
      ];
    },
  },
  // Healing probes
  {
    source_pattern: "heal.augur_process",
    classify(r) {
      const anomalies: HealthAnomaly[] = [];
      if (r.data.pid_found === false) {
        anomalies.push(
          makeAnomaly(
            "process_dead",
            "augur-executor",
            "critical",
            r.source_id,
            r.data,
            "rb-restart-service",
          ),
        );
      }
      if (r.data.zombie === true) {
        anomalies.push(
          makeAnomaly(
            "process_zombie",
            "augur-executor",
            "high",
            r.source_id,
            r.data,
            "rb-kill-zombie",
          ),
        );
      }
      return anomalies;
    },
  },
  {
    source_pattern: "heal.gateway",
    classify(r) {
      if (typeof r.data.consecutive_failures === "number" && r.data.consecutive_failures >= 2) {
        return [
          makeAnomaly(
            "gateway_unresponsive",
            "openclaw-gateway",
            "critical",
            r.source_id,
            r.data,
            "rb-gateway-restart",
          ),
        ];
      }
      return [];
    },
  },
  {
    source_pattern: "heal.brain_db",
    classify(r) {
      if (r.data.integrity_ok === false) {
        return [
          makeAnomaly(
            "db_corruption",
            "brain-db",
            "critical",
            r.source_id,
            r.data,
            "rb-db-emergency",
          ),
        ];
      }
      return [];
    },
  },
  {
    source_pattern: "heal.disk",
    classify(r) {
      const anomalies: HealthAnomaly[] = [];
      const mounts = (r.data.mounts as Array<{ mount: string; usage_pct: number }>) ?? [];
      for (const m of mounts) {
        if (m.usage_pct > 0.95) {
          anomalies.push(
            makeAnomaly(
              "disk_critical",
              `disk:${m.mount}`,
              "critical",
              r.source_id,
              m as unknown as Record<string, unknown>,
              "rb-emergency-cleanup",
            ),
          );
        } else if (m.usage_pct > 0.85) {
          anomalies.push(
            makeAnomaly(
              "disk_pressure",
              `disk:${m.mount}`,
              "high",
              r.source_id,
              m as unknown as Record<string, unknown>,
              "rb-rotate-logs",
            ),
          );
        }
      }
      return anomalies;
    },
  },
  {
    source_pattern: "heal.memory",
    classify(r) {
      const mb = r.data.available_mb as number | undefined;
      if (mb == null) return [];
      if (mb <= 256)
        return [
          makeAnomaly(
            "memory_critical",
            "system-memory",
            "critical",
            r.source_id,
            r.data,
            "rb-force-gc",
          ),
        ];
      if (mb < 512)
        return [
          makeAnomaly(
            "memory_pressure",
            "system-memory",
            "medium",
            r.source_id,
            r.data,
            "rb-gc-trigger",
          ),
        ];
      return [];
    },
  },
  {
    source_pattern: "heal.log_bloat",
    classify(r) {
      const files = r.data.bloated_files as string[] | undefined;
      if (!files || files.length === 0) return [];
      return [
        makeAnomaly("log_bloat", "log-files", "medium", r.source_id, r.data, "rb-rotate-logs"),
      ];
    },
  },
];

export class AnomalyClassifier {
  /**
   * Classify a SourceReading into zero or more HealthAnomaly records.
   * Never throws.
   */
  classify(reading: SourceReading): HealthAnomaly[] {
    if (!reading.available) return [];

    try {
      const anomalies: HealthAnomaly[] = [];
      for (const rule of RULES) {
        if (
          reading.source_id === rule.source_pattern ||
          reading.source_id.startsWith(rule.source_pattern)
        ) {
          anomalies.push(...rule.classify(reading));
        }
      }
      return anomalies;
    } catch {
      return [];
    }
  }
}
