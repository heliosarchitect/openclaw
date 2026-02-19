/**
 * GitAdapter live integration test — requires real git repo.
 * Excluded from fast test suite via .live.test.ts suffix (FINDING-003).
 */
import { describe, expect, it } from "vitest";
import { GitAdapter } from "../../data-sources/git-adapter.js";

describe("GitAdapter (live)", () => {
  it("poll without mock returns real data (graceful)", async () => {
    const adapter = new GitAdapter();
    const reading = await adapter.poll();
    expect(reading.source_id).toBe("git.activity");
    expect(reading).toHaveProperty("data");
  });
});
