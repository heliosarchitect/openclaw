/**
 * Real-Time Learning — Cross-System Relay
 * Cortex v2.6.0 (task-011)
 *
 * Posts structured Synapse messages for cross-agent/cross-system fixes.
 */

import type { FailureEvent, RealtimeLearningDeps } from "../types.js";

export class CrossSystemRelay {
  private deps: RealtimeLearningDeps;

  constructor(deps: RealtimeLearningDeps) {
    this.deps = deps;
  }

  async relay(failure: FailureEvent): Promise<string | undefined> {
    const body = JSON.stringify(
      {
        failure_id: failure.id,
        type: failure.type,
        source: failure.source,
        root_cause: failure.root_cause,
        failure_desc: failure.failure_desc,
        context: failure.context,
        requires_action: true,
        detected_at: failure.detected_at,
      },
      null,
      2,
    );

    return this.deps.sendSynapse(
      `Cross-system propagation: ${failure.root_cause ?? "unknown"}`,
      body,
      "action",
      `cross-system:${failure.id}`,
    );
  }
}
