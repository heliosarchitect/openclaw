import { describe, expect, it } from "vitest";
import { AugurTradesAdapter } from "../../data-sources/augur-trades-adapter.js";

describe("AugurTradesAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new AugurTradesAdapter();
    expect(adapter.source_id).toBe("augur.trades");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new AugurTradesAdapter();
    (adapter as any).mockData = { open_positions: 3 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).open_positions).toBe(3);
  });
});
