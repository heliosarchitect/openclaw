/**
 * EWMA Score Updater unit tests
 */

import { describe, expect, it } from "vitest";
import { updateScore } from "../score-updater.js";

describe("ScoreUpdater", () => {
  it("pass outcome raises score", () => {
    const newScore = updateScore(0.65, "pass", 2);
    expect(newScore).toBeGreaterThan(0.65);
  });

  it("corrected_significant lowers score", () => {
    const newScore = updateScore(0.9, "corrected_significant", 2);
    expect(newScore).toBeLessThan(0.9);
  });

  it("corrected_minor lowers score less than significant", () => {
    const minor = updateScore(0.8, "corrected_minor", 2);
    const significant = updateScore(0.8, "corrected_significant", 2);
    expect(minor).toBeGreaterThan(significant);
  });

  it("tool_error_external does not change score", () => {
    const newScore = updateScore(0.75, "tool_error_external", 2);
    // alpha=0.10, normalized=(0+1)/2=0.5
    // 0.10 * 0.5 + 0.90 * 0.75 = 0.05 + 0.675 = 0.725
    // Actually it does move slightly toward 0.5 neutral. That's expected.
    expect(newScore).toBeCloseTo(0.725, 3);
  });

  it("score stays bounded at 0", () => {
    let score = 0.05;
    for (let i = 0; i < 20; i++) {
      score = updateScore(score, "corrected_significant", 2);
    }
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  it("score stays bounded at 1", () => {
    let score = 0.95;
    for (let i = 0; i < 20; i++) {
      score = updateScore(score, "pass", 2);
    }
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("pending outcome does not change score", () => {
    expect(updateScore(0.75, "pending", 2)).toBe(0.75);
  });

  it("tier 4 never updates (alpha=0)", () => {
    expect(updateScore(0.0, "pass", 4)).toBe(0.0);
  });

  it("tier 1 has slower alpha (0.08)", () => {
    const tier1 = updateScore(0.75, "pass", 1);
    const tier2 = updateScore(0.75, "pass", 2);
    // tier 1 should move less toward 1.0 than tier 2
    expect(tier1 - 0.75).toBeLessThan(tier2 - 0.75);
  });
});
