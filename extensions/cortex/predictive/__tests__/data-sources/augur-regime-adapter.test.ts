import { describe, expect, it } from "vitest";
import { AugurRegimeAdapter } from "../../data-sources/augur-regime-adapter.js";

describe("AugurRegimeAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new AugurRegimeAdapter();
    expect(adapter.source_id).toBe("augur.regime");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new AugurRegimeAdapter();
    (adapter as any).mockData = { regime: "trending", confidence: 0.85 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).regime).toBe("trending");
  });
});
