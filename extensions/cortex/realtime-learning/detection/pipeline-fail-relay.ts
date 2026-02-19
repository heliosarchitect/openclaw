/**
 * Real-Time Learning — Pipeline Fail Relay
 * Cortex v2.6.0 (task-011)
 *
 * Converts pipeline stage failures into failure events.
 */

import type { AsyncQueue } from "../async-queue.js";
import type { DetectionPayload } from "../types.js";

export interface PipelineFailEvent {
  taskId: string;
  stage: string;
  result: "fail" | "blocked";
  message?: string;
  sessionId?: string;
}

export class PipelineFailRelay {
  private queue: AsyncQueue<DetectionPayload>;

  constructor(queue: AsyncQueue<DetectionPayload>) {
    this.queue = queue;
  }

  onPipelineFail(event: PipelineFailEvent): void {
    this.queue.enqueue({
      type: "PIPE_FAIL",
      tier: 3,
      source: `pipeline:${event.taskId}:${event.stage}`,
      context: {
        task_id: event.taskId,
        stage: event.stage,
        result: event.result,
        session_id: event.sessionId,
      },
      failure_desc: `Pipeline ${event.taskId} stage ${event.stage} ${event.result}: ${event.message ?? "no details"}`,
    });
  }
}
