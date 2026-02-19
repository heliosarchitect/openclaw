/**
 * Real-Time Learning — Recurrence Detector
 * Cortex v2.6.0 (task-011)
 *
 * After every propagation, checks if the same root cause has occurred
 * within the configured window (default 30 days). Escalates on recurrence.
 */

import type { FailureEvent, RealtimeLearningConfig, RealtimeLearningDeps } from "../types.js";

export class RecurrenceDetector {
  private config: RealtimeLearningConfig;
  private deps: RealtimeLearningDeps;

  constructor(config: RealtimeLearningConfig, deps: RealtimeLearningDeps) {
    this.config = config;
    this.deps = deps;
  }

  async check(failure: FailureEvent): Promise<boolean> {
    if (!failure.root_cause || failure.root_cause === "unknown") return false;

    const windowMs = this.config.recurrence_window_days * 24 * 3600 * 1000;
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const priors = await this.deps.db.all<{
      id: string;
      detected_at: string;
      propagation_status: string;
    }>(
      `SELECT id, detected_at, propagation_status
       FROM failure_events
       WHERE root_cause = ?
         AND id != ?
         AND detected_at > ?
       ORDER BY detected_at DESC`,
      [failure.root_cause, failure.id, cutoff],
    );

    if (priors.length === 0) return false;

    // Update recurrence count
    await this.deps.db.run(
      `UPDATE failure_events
       SET recurrence_count = recurrence_count + 1, last_recurred_at = ?
       WHERE id = ?`,
      [new Date().toISOString(), failure.id],
    );

    // Escalate via Synapse
    const prior = priors[0];
    await this.deps.sendSynapse(
      `⚠️ Recurrence: ${failure.root_cause}`,
      `Failure pattern "${failure.root_cause}" re-fired.\n` +
        `Prior occurrence: ${prior.id} (${prior.detected_at})\n` +
        `Prior propagation: ${prior.propagation_status}\n` +
        `Current failure: ${failure.failure_desc}\n` +
        `Total prior occurrences in window: ${priors.length}\n\n` +
        `The original propagation did not prevent recurrence — manual review needed.`,
      "urgent",
      `recurrence:${failure.root_cause}`,
    );

    this.deps.logger?.warn?.(
      `[RecurrenceDetector] Root cause "${failure.root_cause}" recurred (${priors.length} prior in ${this.config.recurrence_window_days}d)`,
    );

    return true;
  }
}
