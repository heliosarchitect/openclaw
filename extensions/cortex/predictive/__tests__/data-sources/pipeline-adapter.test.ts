import { describe, expect, it } from "vitest";
import { PipelineAdapter } from "../../data-sources/pipeline-adapter.js";

describe("PipelineAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new PipelineAdapter();
    expect(adapter.source_id).toBe("pipeline.state");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new PipelineAdapter();
    (adapter as any).mockData = { active_task: "task-001", stuck: false };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).active_task).toBe("task-001");
  });

  it("freshness_threshold_ms defaults to 2x poll", () => {
    const adapter = new PipelineAdapter(60000, 120000);
    expect(adapter.freshness_threshold_ms).toBe(120000);
  });
});
