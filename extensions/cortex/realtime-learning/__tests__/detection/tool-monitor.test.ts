import { describe, expect, it } from "vitest";
import type { DetectionPayload } from "../../types.js";
import { AsyncQueue } from "../../async-queue.js";
import { ToolMonitor } from "../../detection/tool-monitor.js";

describe("ToolMonitor", () => {
  it("enqueues on non-zero exit code", () => {
    const items: DetectionPayload[] = [];
    const queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      items.push(item);
    });
    const monitor = new ToolMonitor(queue);
    monitor.onToolResult({ toolName: "exec", exitCode: 1, error: "not found" });
    expect(queue.pending).toBe(1);
  });

  it("enqueues on exception", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const monitor = new ToolMonitor(queue);
    monitor.onToolResult({ toolName: "exec", exception: true, error: "TypeError" });
    expect(queue.pending).toBe(1);
  });

  it("does not enqueue on success (exit 0)", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const monitor = new ToolMonitor(queue);
    monitor.onToolResult({ toolName: "exec", exitCode: 0 });
    expect(queue.pending).toBe(0);
  });

  it("does not enqueue on no exit code and no exception", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const monitor = new ToolMonitor(queue);
    monitor.onToolResult({ toolName: "exec" });
    expect(queue.pending).toBe(0);
  });

  it("includes session and tool call context in payload", async () => {
    const items: DetectionPayload[] = [];
    const queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      items.push(item);
    });
    const monitor = new ToolMonitor(queue);
    monitor.onToolResult({ toolName: "write", exitCode: 2, sessionId: "s1", toolCallId: "tc1" });
    // Wait for drain
    await new Promise((r) => setTimeout(r, 50));
    expect(items).toHaveLength(1);
    expect(items[0].context.session_id).toBe("s1");
    expect(items[0].context.tool_call_id).toBe("tc1");
    expect(items[0].type).toBe("TOOL_ERR");
  });
});
