import { describe, expect, it } from "vitest";
import { CortexAtomsAdapter } from "../../data-sources/cortex-atoms-adapter.js";

describe("CortexAtomsAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new CortexAtomsAdapter();
    expect(adapter.source_id).toBe("cortex.atoms");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new CortexAtomsAdapter();
    (adapter as any).mockData = { atoms: 42 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).atoms).toBe(42);
  });
});
