/**
 * Real-Time Learning — Metrics Emitter
 * Cortex v2.6.0 (task-011)
 *
 * Computes T2P, propagation completeness, recurrence rate from brain.db.
 */

import type { FailureType, LearningMetrics, RealtimeLearningDB } from "../types.js";

export class MetricsEmitter {
  private db: RealtimeLearningDB;

  constructor(db: RealtimeLearningDB) {
    this.db = db;
  }

  async compute(): Promise<LearningMetrics> {
    // Time-to-propagation average
    const t2p = await this.db.get<{ avg_t2p: number | null }>(
      `SELECT AVG(
        (julianday(completed_at) - julianday(started_at)) * 86400
      ) as avg_t2p
      FROM propagation_records
      WHERE status = 'committed' AND completed_at IS NOT NULL`,
    );

    // Propagation completeness
    const totalFailures = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM failure_events WHERE propagation_status != 'no_fix_needed'`,
    );
    const propagated = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(DISTINCT failure_id) as cnt FROM propagation_records WHERE status = 'committed'`,
    );
    const completeness =
      totalFailures?.cnt && totalFailures.cnt > 0
        ? ((propagated?.cnt ?? 0) / totalFailures.cnt) * 100
        : null;

    // Recurrence rate
    const totalEvents = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM failure_events`,
    );
    const recurring = await this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM failure_events WHERE recurrence_count > 0`,
    );
    const recurrenceRate =
      totalEvents?.cnt && totalEvents.cnt > 0
        ? ((recurring?.cnt ?? 0) / totalEvents.cnt) * 100
        : null;

    // Failures by type
    const byType = await this.db.all<{ type: string; cnt: number }>(
      `SELECT type, COUNT(*) as cnt FROM failure_events GROUP BY type`,
    );
    const failuresByType: Record<FailureType, number> = {
      TOOL_ERR: 0,
      CORRECT: 0,
      SOP_VIOL: 0,
      TRUST_DEM: 0,
      PIPE_FAIL: 0,
    };
    for (const row of byType) {
      if (row.type in failuresByType) {
        failuresByType[row.type as FailureType] = row.cnt;
      }
    }

    return {
      avg_t2p_seconds: t2p?.avg_t2p ?? null,
      propagation_completeness_pct: completeness,
      recurrence_rate_pct: recurrenceRate,
      total_failures: totalEvents?.cnt ?? 0,
      total_propagations: propagated?.cnt ?? 0,
      failures_by_type: failuresByType,
    };
  }

  /**
   * Format metrics as a human-readable Synapse report.
   */
  async formatReport(): Promise<string> {
    const m = await this.compute();

    return [
      "📊 **Real-Time Learning — Weekly Metrics**",
      "",
      `**Time-to-Propagation (avg):** ${m.avg_t2p_seconds !== null ? `${m.avg_t2p_seconds.toFixed(1)}s` : "N/A"}`,
      `**Propagation Completeness:** ${m.propagation_completeness_pct !== null ? `${m.propagation_completeness_pct.toFixed(1)}%` : "N/A"}`,
      `**Recurrence Rate:** ${m.recurrence_rate_pct !== null ? `${m.recurrence_rate_pct.toFixed(1)}%` : "N/A"}`,
      `**Total Failures:** ${m.total_failures}`,
      `**Total Propagations:** ${m.total_propagations}`,
      "",
      "**By Type:**",
      ...Object.entries(m.failures_by_type)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `- ${k}: ${v}`),
      ...(Object.values(m.failures_by_type).every((v) => v === 0) ? ["- (none recorded)"] : []),
    ].join("\n");
  }
}
