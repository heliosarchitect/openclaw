import { describe, expect, it } from "vitest";
import type { DetectionPayload } from "../../types.js";
import { AsyncQueue } from "../../async-queue.js";
import { PipelineFailRelay } from "../../detection/pipeline-fail-relay.js";

describe("PipelineFailRelay", () => {
  it("enqueues on pipeline fail", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const relay = new PipelineFailRelay(queue);
    relay.onPipelineFail({
      taskId: "task-001",
      stage: "build",
      result: "fail",
      message: "tsc error",
    });
    expect(queue.pending).toBe(1);
  });

  it("enqueues on pipeline blocked", () => {
    const queue = new AsyncQueue<DetectionPayload>();
    const relay = new PipelineFailRelay(queue);
    relay.onPipelineFail({ taskId: "task-002", stage: "security", result: "blocked" });
    expect(queue.pending).toBe(1);
  });

  it("payload has correct type and tier", async () => {
    const items: DetectionPayload[] = [];
    const queue = new AsyncQueue<DetectionPayload>();
    queue.onDrain(async (item) => {
      items.push(item);
    });
    const relay = new PipelineFailRelay(queue);
    relay.onPipelineFail({ taskId: "task-001", stage: "build", result: "fail" });
    await new Promise((r) => setTimeout(r, 50));
    expect(items[0].type).toBe("PIPE_FAIL");
    expect(items[0].tier).toBe(3);
    expect(items[0].source).toContain("task-001");
  });
});
