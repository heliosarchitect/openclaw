import { describe, expect, it } from "vitest";
import { AugurSignalsAdapter } from "../../data-sources/augur-signals-adapter.js";

describe("AugurSignalsAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new AugurSignalsAdapter();
    expect(adapter.source_id).toBe("augur.signals");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new AugurSignalsAdapter();
    (adapter as any).mockData = { signals: 5, stale: false };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).signals).toBe(5);
  });
});
