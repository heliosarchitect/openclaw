/**
 * Real-Time Learning — Trust Event Relay
 * Cortex v2.6.0 (task-011)
 *
 * Converts trust demotion events from task-010 earned autonomy into failure events.
 */

import type { AsyncQueue } from "../async-queue.js";
import type { DetectionPayload } from "../types.js";

export interface TrustDemotionEvent {
  milestone: string;
  priorTier: number;
  reason: string;
  sessionId?: string;
}

export class TrustEventRelay {
  private queue: AsyncQueue<DetectionPayload>;

  constructor(queue: AsyncQueue<DetectionPayload>) {
    this.queue = queue;
  }

  onDemotion(event: TrustDemotionEvent): void {
    this.queue.enqueue({
      type: "TRUST_DEM",
      tier: 3,
      source: "task-010-trust-engine",
      context: {
        milestone: event.milestone,
        prior_tier: event.priorTier,
        session_id: event.sessionId,
      },
      failure_desc: `Trust demotion: ${event.reason}`,
    });
  }
}
