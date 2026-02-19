/**
 * Unit tests for Reporter
 */
import { describe, it, expect } from "vitest";
import type { CompressionRunReport } from "../types.js";
import { formatSynapseSummary } from "../reporter.js";

function makeReport(overrides: Partial<CompressionRunReport> = {}): CompressionRunReport {
  return {
    run_id: "test-run",
    started_at: "2026-02-18T03:30:00Z",
    finished_at: "2026-02-18T03:32:00Z",
    duration_ms: 120000,
    memories_scanned: 200,
    clusters_found: 8,
    clusters_skipped: 2,
    clusters_compressed: 6,
    memories_archived: 24,
    abstractions_created: 6,
    atoms_created: 3,
    atoms_enriched: 1,
    tokens_before: 50000,
    tokens_after: 30000,
    token_reduction_pct: 40.0,
    avg_compression_ratio: 3.5,
    max_compression_ratio: 5.2,
    errors: [],
    verdict: "PASS",
    ...overrides,
  };
}

describe("formatSynapseSummary", () => {
  it("includes key metrics", () => {
    const summary = formatSynapseSummary(makeReport());
    expect(summary).toContain("200 memories");
    expect(summary).toContain("6 clusters");
    expect(summary).toContain("24 source memories");
    expect(summary).toContain("40.0%");
    expect(summary).toContain("3.5x");
    expect(summary).toContain("PASS");
  });

  it("includes error summary when errors exist", () => {
    const summary = formatSynapseSummary(
      makeReport({
        errors: [
          {
            cluster_id: "c1",
            stage: "distill",
            message: "API timeout",
            timestamp: "2026-02-18T03:31:00Z",
          },
        ],
        verdict: "PARTIAL",
      }),
    );
    expect(summary).toContain("Errors: 1");
    expect(summary).toContain("[distill]");
    expect(summary).toContain("PARTIAL");
  });

  it("handles zero-state report", () => {
    const summary = formatSynapseSummary(
      makeReport({
        memories_scanned: 0,
        clusters_found: 0,
        clusters_compressed: 0,
        memories_archived: 0,
        tokens_before: 0,
        tokens_after: 0,
        token_reduction_pct: 0,
        avg_compression_ratio: 0,
      }),
    );
    expect(summary).toContain("0 memories");
    expect(summary).toContain("0.0%");
  });
});
