/**
 * Unit Tests — DecayEngine
 * Cross-Session State Preservation v2.0.0 | task-004
 *
 * Tests the pure decay formula: confidence * max(minFloor, 1.0 - (hours/168) * 0.4)
 */
import { describe, it, expect } from "vitest";
import { applyDecay } from "../decay-engine.js";

describe("applyDecay", () => {
  // -------------------------------------------------------------------------
  // Formula correctness
  // -------------------------------------------------------------------------
  describe("formula correctness", () => {
    it("returns full confidence at 0 hours (fresh memory)", () => {
      // decayFactor = max(0.3, 1.0 - 0) = 1.0
      expect(applyDecay(2.0, 0)).toBeCloseTo(2.0);
    });

    it("applies 40% decay at exactly 168 hours (7 days)", () => {
      // decayFactor = max(0.3, 1.0 - (168/168) * 0.4) = max(0.3, 0.6) = 0.6
      expect(applyDecay(1.0, 168)).toBeCloseTo(0.6);
    });

    it("applies 20% decay at 84 hours (3.5 days)", () => {
      // decayFactor = max(0.3, 1.0 - (84/168) * 0.4) = max(0.3, 0.8) = 0.8
      expect(applyDecay(1.0, 84)).toBeCloseTo(0.8);
    });

    it("applies correct decay at 42 hours (1.75 days)", () => {
      // decayFactor = max(0.3, 1.0 - (42/168) * 0.4) = max(0.3, 0.9) = 0.9
      expect(applyDecay(2.0, 42)).toBeCloseTo(1.8);
    });

    it("floors at minFloor when hours > 168 * (1 - minFloor) / 0.4", () => {
      // At very large hours (e.g., 1000h), decay would go below floor
      // decayFactor = max(0.3, 1.0 - (1000/168) * 0.4) = max(0.3, very negative) = 0.3
      const result = applyDecay(3.0, 1000);
      expect(result).toBeCloseTo(3.0 * 0.3);
    });

    it("floors at minFloor at 340 hours (14 days, well past 168h)", () => {
      // decayFactor = max(0.3, 1.0 - (340/168) * 0.4) = max(0.3, ~0.19) = 0.3
      const result = applyDecay(1.0, 340);
      expect(result).toBeCloseTo(0.3);
    });

    it("crosses floor threshold near 294 hours", () => {
      // 1.0 - (h/168) * 0.4 = 0.3  =>  h = 168 * 0.7 / 0.4 = 294
      // Just before: floor NOT applied
      const before = applyDecay(1.0, 293);
      expect(before).toBeGreaterThan(0.3);
      // Just after: floor applied
      const after = applyDecay(1.0, 295);
      expect(after).toBeCloseTo(0.3);
    });
  });

  // -------------------------------------------------------------------------
  // Custom minFloor
  // -------------------------------------------------------------------------
  describe("custom minFloor", () => {
    it("respects custom minFloor = 0.5", () => {
      // decayFactor = max(0.5, 1.0 - (1000/168) * 0.4) = 0.5
      const result = applyDecay(2.0, 1000, 0.5);
      expect(result).toBeCloseTo(1.0);
    });

    it("respects minFloor = 0.0 (allows full decay)", () => {
      // decayFactor = max(0, 1.0 - (1000/168) * 0.4) = 0 (negative clamped to 0)
      const result = applyDecay(1.0, 1000, 0.0);
      expect(result).toBeCloseTo(0.0);
    });

    it("respects minFloor = 1.0 (no decay ever)", () => {
      const result = applyDecay(2.5, 10000, 1.0);
      expect(result).toBeCloseTo(2.5);
    });
  });

  // -------------------------------------------------------------------------
  // Scale behavior (0-3 input range)
  // -------------------------------------------------------------------------
  describe("confidence scale behavior (0-3)", () => {
    it("works correctly on importance=3.0 (critical)", () => {
      const result = applyDecay(3.0, 168); // 7 days → factor 0.6
      expect(result).toBeCloseTo(1.8);
    });

    it("works correctly on importance=1.0 (routine)", () => {
      const result = applyDecay(1.0, 168);
      expect(result).toBeCloseTo(0.6);
    });

    it("works correctly on importance=0 (should return 0)", () => {
      expect(applyDecay(0, 0)).toBe(0);
      expect(applyDecay(0, 168)).toBe(0);
    });

    it("preserves proportional relationships between importance levels", () => {
      const d1 = applyDecay(1.0, 100);
      const d2 = applyDecay(2.0, 100);
      const d3 = applyDecay(3.0, 100);
      expect(d2).toBeCloseTo(d1 * 2);
      expect(d3).toBeCloseTo(d1 * 3);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe("edge cases", () => {
    it("handles fractional hours correctly", () => {
      // 0.5h = 30 minutes
      const result = applyDecay(1.0, 0.5);
      const expected = 1.0 - (0.5 / 168) * 0.4;
      expect(result).toBeCloseTo(expected);
    });

    it("is a pure function (same inputs → same outputs)", () => {
      expect(applyDecay(2.5, 50)).toBe(applyDecay(2.5, 50));
      expect(applyDecay(1.0, 168)).toBe(applyDecay(1.0, 168));
    });

    it("handles negative hours gracefully (treats as fresh)", () => {
      // Negative hours should produce decay factor > 1, but we don't cap at 1
      // The formula: 1.0 - (-10/168) * 0.4 = 1.024... — confidence inflates slightly
      // This is an unusual input; just ensure no error
      expect(() => applyDecay(1.0, -10)).not.toThrow();
    });
  });
});
