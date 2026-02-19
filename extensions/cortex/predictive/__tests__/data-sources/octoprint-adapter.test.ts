import { describe, expect, it } from "vitest";
import { OctoPrintAdapter } from "../../data-sources/octoprint-adapter.js";

describe("OctoPrintAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new OctoPrintAdapter();
    expect(adapter.source_id).toBe("octoprint.jobs");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new OctoPrintAdapter();
    (adapter as any).mockData = { printing: true, progress: 45 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).progress).toBe(45);
  });
});
