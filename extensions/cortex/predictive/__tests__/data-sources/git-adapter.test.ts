import { describe, expect, it } from "vitest";
import { GitAdapter } from "../../data-sources/git-adapter.js";

describe("GitAdapter", () => {
  it("source_id is correct", () => {
    const adapter = new GitAdapter();
    expect(adapter.source_id).toBe("git.activity");
  });

  it("poll with mockData returns mock", async () => {
    const adapter = new GitAdapter();
    (adapter as any).mockData = { repos: 5, recent_commits: 10 };
    const reading = await adapter.poll();
    expect(reading.available).toBe(true);
    expect((reading.data as any).repos).toBe(5);
  });

  // Live git execution moved to git-adapter.live.test.ts (FINDING-003)
});
