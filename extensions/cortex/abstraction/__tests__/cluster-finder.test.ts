/**
 * Unit tests for Cluster Finder
 */
import { describe, it, expect } from "vitest";
import { clusterFingerprint } from "../cluster-finder.js";

describe("clusterFingerprint", () => {
  it("produces deterministic output for same IDs regardless of order", () => {
    const fp1 = clusterFingerprint(["a", "b", "c"]);
    const fp2 = clusterFingerprint(["c", "a", "b"]);
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints for different ID sets", () => {
    const fp1 = clusterFingerprint(["a", "b", "c"]);
    const fp2 = clusterFingerprint(["a", "b", "d"]);
    expect(fp1).not.toBe(fp2);
  });

  it("returns a 64-char hex string (SHA-256)", () => {
    const fp = clusterFingerprint(["x", "y", "z"]);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
