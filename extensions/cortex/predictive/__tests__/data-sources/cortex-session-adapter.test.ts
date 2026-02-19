import { describe, expect, it } from "vitest";
import { CortexSessionAdapter } from "../../data-sources/cortex-session-adapter.js";

describe("CortexSessionAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new CortexSessionAdapter();
    expect(adapter.source_id).toBe("cortex.session");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new CortexSessionAdapter();
    (adapter as any).mockData = { hot_topics: ["trading"] };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).hot_topics).toContain("trading");
  });
});
