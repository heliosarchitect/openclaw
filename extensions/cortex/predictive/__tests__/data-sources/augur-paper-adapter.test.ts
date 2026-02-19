import { describe, expect, it } from "vitest";
import { AugurPaperAdapter } from "../../data-sources/augur-paper-adapter.js";

describe("AugurPaperAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new AugurPaperAdapter();
    expect(adapter.source_id).toBe("augur.paper");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new AugurPaperAdapter();
    (adapter as any).mockData = { total_pnl: 0.05 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).total_pnl).toBe(0.05);
  });
});
