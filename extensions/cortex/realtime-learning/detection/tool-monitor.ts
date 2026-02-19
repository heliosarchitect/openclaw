/**
 * Real-Time Learning — Tool Monitor
 * Cortex v2.6.0 (task-011)
 *
 * Monitors tool execution results for errors. Enqueues failure detections
 * for exec/write/gateway non-zero exits or exceptions.
 */

import type { AsyncQueue } from "../async-queue.js";
import type { DetectionPayload } from "../types.js";

export interface ToolResultEvent {
  toolName: string;
  exitCode?: number;
  error?: string;
  exception?: boolean;
  input?: string;
  sessionId?: string;
  toolCallId?: string;
}

export class ToolMonitor {
  private queue: AsyncQueue<DetectionPayload>;
  private logger?: { debug?: (msg: string) => void };

  constructor(queue: AsyncQueue<DetectionPayload>, logger?: { debug?: (msg: string) => void }) {
    this.queue = queue;
    this.logger = logger;
  }

  /**
   * Process a tool result event. Call this from the after_tool_call hook.
   * Enqueues synchronously — guaranteed ≤1ms overhead.
   */
  onToolResult(event: ToolResultEvent): void {
    if (event.exitCode !== undefined && event.exitCode !== 0) {
      this.logger?.debug?.(
        `[ToolMonitor] Error detected: ${event.toolName} exit=${event.exitCode}`,
      );
      this.queue.enqueue({
        type: "TOOL_ERR",
        tier: 1,
        source: event.toolName,
        context: {
          session_id: event.sessionId,
          tool_call_id: event.toolCallId,
          exit_code: event.exitCode,
        },
        raw_input: event.input,
        failure_desc: `Tool ${event.toolName} failed: ${event.error ?? `exit ${event.exitCode}`}`,
      });
    } else if (event.exception) {
      this.logger?.debug?.(`[ToolMonitor] Exception in ${event.toolName}: ${event.error}`);
      this.queue.enqueue({
        type: "TOOL_ERR",
        tier: 1,
        source: event.toolName,
        context: {
          session_id: event.sessionId,
          tool_call_id: event.toolCallId,
        },
        raw_input: event.input,
        failure_desc: `Tool ${event.toolName} threw: ${event.error ?? "unknown exception"}`,
      });
    }
  }
}
