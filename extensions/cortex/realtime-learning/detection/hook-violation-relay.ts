/**
 * Real-Time Learning — Hook Violation Relay
 * Cortex v2.6.0 (task-011)
 *
 * Converts SOP violation events from task-003 pre-action hooks into failure events.
 */

import type { AsyncQueue } from "../async-queue.js";
import type { DetectionPayload } from "../types.js";

export interface SopViolationEvent {
  hookId: string;
  sopFile: string;
  ruleId: string;
  description?: string;
  sessionId?: string;
}

export class HookViolationRelay {
  private queue: AsyncQueue<DetectionPayload>;

  constructor(queue: AsyncQueue<DetectionPayload>) {
    this.queue = queue;
  }

  onViolation(event: SopViolationEvent): void {
    this.queue.enqueue({
      type: "SOP_VIOL",
      tier: 2,
      source: event.hookId,
      context: {
        sop_file: event.sopFile,
        rule_id: event.ruleId,
        session_id: event.sessionId,
      },
      failure_desc:
        event.description ?? `SOP ${event.sopFile} rule "${event.ruleId}" fired but flagged stale`,
    });
  }
}
