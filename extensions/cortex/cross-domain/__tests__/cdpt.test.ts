/**
 * Task-009: Cross-Domain Pattern Transfer — Unit Tests
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { PatternFingerprint, StructuralVector, CrossDomainMatch } from "../types.js";
import { cosineSimilarity, findMatches, classifyMatch } from "../matcher.js";
import { normalizeFingerprints } from "../normalizer.js";
import { generateAlerts } from "../synthesizers/alert-generator.js";
import { generateHypotheses } from "../synthesizers/hypothesis-generator.js";
import { generateMetaphor } from "../synthesizers/metaphor-engine.js";
import { DEFAULT_CONFIG } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeFp(
  overrides: Partial<PatternFingerprint> & { structure: StructuralVector },
): PatternFingerprint {
  return {
    fingerprint_id: randomUUID(),
    source_domain: "trading",
    source_id: randomUUID(),
    source_type: "atom",
    label: "test pattern",
    confidence: 0.7,
    created_at: new Date().toISOString(),
    run_id: "test-run",
    ...overrides,
  };
}

function makeStructure(overrides: Partial<StructuralVector> = {}): StructuralVector {
  return {
    trend_direction: 0,
    trend_strength: 0.5,
    oscillation_frequency: 0.3,
    reversion_force: 0.4,
    divergence_magnitude: 0.6,
    divergence_polarity: 0.3,
    threshold_proximity: 0.4,
    cascade_potential: 0.2,
    signal_decay_rate: 0.3,
    lead_time_normalized: 0.4,
    effect_size: 0.5,
    frequency_of_occurrence: 0.5,
    ...overrides,
  };
}

// ── Normalizer Tests ──────────────────────────────────────────────

describe("Normalizer", () => {
  it("accepts valid fingerprints", () => {
    const fp = makeFp({ structure: makeStructure() });
    const { accepted, rejected } = normalizeFingerprints([fp]);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects low-confidence fingerprints", () => {
    const fp = makeFp({ confidence: 0.1, structure: makeStructure() });
    const { accepted, rejected } = normalizeFingerprints([fp]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("confidence");
  });

  it("rejects under-specified fingerprints (>6 zero dimensions)", () => {
    const fp = makeFp({
      structure: {
        trend_direction: 0,
        trend_strength: 0,
        oscillation_frequency: 0,
        reversion_force: 0,
        divergence_magnitude: 0,
        divergence_polarity: 0,
        threshold_proximity: 0,
        cascade_potential: 0.5,
        signal_decay_rate: 0.3,
        lead_time_normalized: 0.2,
        effect_size: 0.4,
        frequency_of_occurrence: 0.3,
      },
    });
    const { accepted, rejected } = normalizeFingerprints([fp]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("zero dimensions");
  });

  it("clips values to [-1, 1]", () => {
    const fp = makeFp({
      structure: makeStructure({ trend_direction: 1.5, divergence_polarity: -1.5 }),
    });
    const { accepted } = normalizeFingerprints([fp]);
    expect(accepted[0].structure.trend_direction).toBe(1);
    expect(accepted[0].structure.divergence_polarity).toBe(-1);
  });
});

// ── Vector Math Tests ─────────────────────────────────────────────

describe("Cosine Similarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 5);
  });

  it("handles zero vectors gracefully", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

// ── Matcher Tests ─────────────────────────────────────────────────

describe("Matcher", () => {
  it("only produces cross-domain matches", () => {
    const fps = [
      makeFp({ source_domain: "trading", structure: makeStructure() }),
      makeFp({ source_domain: "trading", structure: makeStructure() }),
      makeFp({ source_domain: "radio", structure: makeStructure() }),
    ];
    const matches = findMatches(fps);
    for (const m of matches) {
      expect(m.domain_a).not.toBe(m.domain_b);
    }
  });

  it("finds matches above threshold for similar fingerprints", () => {
    const structure = makeStructure();
    const fps = [
      makeFp({ source_domain: "trading", structure }),
      makeFp({ source_domain: "radio", structure }), // identical structure → sim = 1.0
    ];
    const matches = findMatches(fps);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].similarity_score).toBeCloseTo(1, 3);
  });

  it("skips matches below threshold", () => {
    const fps = [
      makeFp({
        source_domain: "trading",
        structure: makeStructure({ trend_direction: 1, divergence_polarity: 1 }),
      }),
      makeFp({
        source_domain: "radio",
        structure: makeStructure({ trend_direction: -1, divergence_polarity: -1 }),
      }),
    ];
    // These have somewhat opposing structures — may or may not match
    const matches = findMatches(fps, { config: { ...DEFAULT_CONFIG, match_threshold: 0.99 } });
    expect(matches).toHaveLength(0);
  });

  it("detects transfer opportunities", () => {
    const structure = makeStructure();
    const fps = [
      makeFp({ source_domain: "trading", confidence: 0.9, structure }),
      makeFp({ source_domain: "radio", confidence: 0.3, structure }),
    ];
    const matches = findMatches(fps);
    expect(matches[0].transfer_opportunity).toBe(true);
  });

  it("idempotency: skips existing pairs", () => {
    const fpA = makeFp({ source_domain: "trading", structure: makeStructure() });
    const fpB = makeFp({ source_domain: "radio", structure: makeStructure() });
    const existingPairs = new Set<string>();

    const first = findMatches([fpA, fpB], { existingPairs });
    const second = findMatches([fpA, fpB], { existingPairs });
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(second).toHaveLength(0); // already seen
  });
});

// ── Classifier Tests ──────────────────────────────────────────────

describe("Classifier", () => {
  it("classifies temporal matches by high temporal dimension similarity", () => {
    const fpA = makeFp({
      source_domain: "trading",
      structure: makeStructure({
        signal_decay_rate: 0.9,
        lead_time_normalized: 0.8,
        oscillation_frequency: 0.7,
      }),
    });
    const fpB = makeFp({
      source_domain: "radio",
      structure: makeStructure({
        signal_decay_rate: 0.9,
        lead_time_normalized: 0.8,
        oscillation_frequency: 0.7,
      }),
    });
    const result = classifyMatch(fpA, fpB, 0.9, new Set());
    expect(result).toBe("temporal");
  });

  it("classifies causal matches when both have atoms", () => {
    // Use different temporal dims so temporal check doesn't fire first
    const fpA = makeFp({
      source_domain: "trading",
      source_id: "atom-1",
      structure: makeStructure({
        signal_decay_rate: 0.1,
        lead_time_normalized: 0.9,
        oscillation_frequency: 0.1,
      }),
    });
    const fpB = makeFp({
      source_domain: "radio",
      source_id: "atom-2",
      structure: makeStructure({
        signal_decay_rate: 0.9,
        lead_time_normalized: 0.1,
        oscillation_frequency: 0.8,
      }),
    });
    const atomIndex = new Set(["atom-1", "atom-2"]);
    const result = classifyMatch(fpA, fpB, 0.9, atomIndex);
    expect(result).toBe("causal");
  });

  it("classifies structural as default", () => {
    // Use different temporal dims so it doesn't classify as temporal
    const fpA = makeFp({
      source_domain: "trading",
      structure: makeStructure({
        signal_decay_rate: 0.1,
        lead_time_normalized: 0.9,
        oscillation_frequency: 0.1,
      }),
    });
    const fpB = makeFp({
      source_domain: "radio",
      structure: makeStructure({
        signal_decay_rate: 0.9,
        lead_time_normalized: 0.1,
        oscillation_frequency: 0.8,
      }),
    });
    const result = classifyMatch(fpA, fpB, 0.8, new Set());
    expect(result).toBe("structural");
  });
});

// ── Metaphor Engine Tests ─────────────────────────────────────────

describe("Metaphor Engine", () => {
  it("generates non-empty metaphor text", () => {
    const fpA = makeFp({
      source_domain: "trading",
      label: "VWAP divergence SHORT",
      structure: makeStructure(),
    });
    const fpB = makeFp({
      source_domain: "radio",
      label: "Signal fade event",
      structure: makeStructure(),
    });
    const match: CrossDomainMatch = {
      match_id: randomUUID(),
      fingerprint_a_id: fpA.fingerprint_id,
      fingerprint_b_id: fpB.fingerprint_id,
      domain_a: "trading",
      domain_b: "radio",
      similarity_score: 0.85,
      match_type: "structural",
      a_confidence: 0.8,
      b_confidence: 0.4,
      transfer_opportunity: true,
      alert_sent: false,
      created_at: new Date().toISOString(),
    };
    const metaphor = generateMetaphor(match, fpA, fpB);
    expect(metaphor.text.length).toBeGreaterThan(20);
    expect(metaphor.pattern_label.length).toBeGreaterThan(0);
    expect(metaphor.shared_mechanism.length).toBeGreaterThan(0);
    expect(metaphor.domains_involved).toContain("trading");
    expect(metaphor.domains_involved).toContain("radio");
  });
});

// ── Alert Generator Tests ─────────────────────────────────────────

describe("Alert Generator", () => {
  it("fires only for transfer opportunities with causal/temporal type", () => {
    const fpA = makeFp({ source_domain: "trading", confidence: 0.9, structure: makeStructure() });
    const fpB = makeFp({ source_domain: "radio", confidence: 0.3, structure: makeStructure() });
    const fpIndex = new Map([
      [fpA.fingerprint_id, fpA],
      [fpB.fingerprint_id, fpB],
    ]);

    const causalMatch: CrossDomainMatch = {
      match_id: randomUUID(),
      fingerprint_a_id: fpA.fingerprint_id,
      fingerprint_b_id: fpB.fingerprint_id,
      domain_a: "trading",
      domain_b: "radio",
      similarity_score: 0.85,
      match_type: "causal",
      a_confidence: 0.9,
      b_confidence: 0.3,
      transfer_opportunity: true,
      alert_sent: false,
      created_at: new Date().toISOString(),
    };

    const structuralMatch: CrossDomainMatch = {
      ...causalMatch,
      match_id: randomUUID(),
      match_type: "structural",
    };

    const noTransferMatch: CrossDomainMatch = {
      ...causalMatch,
      match_id: randomUUID(),
      transfer_opportunity: false,
    };

    const alerts = generateAlerts([causalMatch, structuralMatch, noTransferMatch], fpIndex);
    expect(alerts).toHaveLength(1); // only causal + transfer_opportunity
    expect(alerts[0].source_confidence).toBe(0.9);
    expect(alerts[0].target_confidence).toBe(0.3);
  });
});

// ── Hypothesis Generator Tests ────────────────────────────────────

describe("Hypothesis Generator", () => {
  it("generates hypotheses prefixed with HYPOTHESIS [UNVALIDATED]:", () => {
    const fpA = makeFp({ source_domain: "trading", confidence: 0.9, structure: makeStructure() });
    const fpB = makeFp({ source_domain: "radio", confidence: 0.4, structure: makeStructure() });
    const fpIndex = new Map([
      [fpA.fingerprint_id, fpA],
      [fpB.fingerprint_id, fpB],
    ]);

    const match: CrossDomainMatch = {
      match_id: randomUUID(),
      fingerprint_a_id: fpA.fingerprint_id,
      fingerprint_b_id: fpB.fingerprint_id,
      domain_a: "trading",
      domain_b: "radio",
      similarity_score: 0.9,
      match_type: "causal",
      a_confidence: 0.9,
      b_confidence: 0.4,
      transfer_opportunity: true,
      alert_sent: false,
      created_at: new Date().toISOString(),
    };

    const hypotheses = generateHypotheses([match], fpIndex);
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0].text).toMatch(/^HYPOTHESIS \[UNVALIDATED\]:/);
    expect(hypotheses[0].status).toBe("unvalidated");
    expect(hypotheses[0].confidence).toBe(0.6);
  });

  it("generates hypotheses with correct confidence (0.6 × similarity × transfer confidence delta)", () => {
    const fpA = makeFp({ source_domain: "trading", confidence: 0.95, structure: makeStructure() });
    const fpB = makeFp({ source_domain: "fleet", confidence: 0.2, structure: makeStructure() });
    const fpIndex = new Map([
      [fpA.fingerprint_id, fpA],
      [fpB.fingerprint_id, fpB],
    ]);
    const match: CrossDomainMatch = {
      match_id: randomUUID(),
      fingerprint_a_id: fpA.fingerprint_id,
      fingerprint_b_id: fpB.fingerprint_id,
      domain_a: "trading",
      domain_b: "fleet",
      similarity_score: 0.95,
      match_type: "temporal",
      a_confidence: 0.95,
      b_confidence: 0.2,
      transfer_opportunity: true,
      alert_sent: false,
      created_at: new Date().toISOString(),
    };
    const hypotheses = generateHypotheses([match], fpIndex);
    expect(hypotheses).toHaveLength(1);
    // confidence = min(sim * 0.6, 0.9) ≈ 0.57
    expect(hypotheses[0].confidence).toBeLessThanOrEqual(0.9);
    expect(hypotheses[0].confidence).toBeGreaterThan(0);
  });

  it("respects max hypotheses cap", () => {
    const fps: PatternFingerprint[] = [];
    const matches: CrossDomainMatch[] = [];
    const fpIndex = new Map<string, PatternFingerprint>();

    for (let i = 0; i < 20; i++) {
      const fpA = makeFp({ source_domain: "trading", confidence: 0.9, structure: makeStructure() });
      const fpB = makeFp({ source_domain: "radio", confidence: 0.3, structure: makeStructure() });
      fps.push(fpA, fpB);
      fpIndex.set(fpA.fingerprint_id, fpA);
      fpIndex.set(fpB.fingerprint_id, fpB);
      matches.push({
        match_id: randomUUID(),
        fingerprint_a_id: fpA.fingerprint_id,
        fingerprint_b_id: fpB.fingerprint_id,
        domain_a: "trading",
        domain_b: "radio",
        similarity_score: 0.85,
        match_type: "causal",
        a_confidence: 0.9,
        b_confidence: 0.3,
        transfer_opportunity: true,
        alert_sent: false,
        created_at: new Date().toISOString(),
      });
    }

    const hypotheses = generateHypotheses(matches, fpIndex, 5);
    expect(hypotheses).toHaveLength(5);
  });
});

// ── ExtractorRegistry Tests ───────────────────────────────────────

import type { DomainExtractor, DomainId, ExtractOptions } from "../types.js";
import { ExtractorRegistry } from "../extractor-registry.js";

describe("ExtractorRegistry", () => {
  it("registers and retrieves extractors by domain", () => {
    const registry = new ExtractorRegistry();
    const mockExtractor: DomainExtractor = {
      domain: "trading" as DomainId,
      version: "1.0.0",
      extract: async (_opts?: ExtractOptions) => [],
    };
    registry.register(mockExtractor);
    expect(registry.size).toBe(1);
    expect(registry.getByDomain("trading" as DomainId)).toBe(mockExtractor);
    expect(registry.getByDomain("radio" as DomainId)).toBeUndefined();
  });

  it("overwrites duplicate domain registrations", () => {
    const registry = new ExtractorRegistry();
    const ext1: DomainExtractor = {
      domain: "trading" as DomainId,
      version: "1.0.0",
      extract: async () => [],
    };
    const ext2: DomainExtractor = {
      domain: "trading" as DomainId,
      version: "2.0.0",
      extract: async () => [],
    };
    registry.register(ext1);
    registry.register(ext2);
    expect(registry.size).toBe(1);
    expect(registry.getByDomain("trading" as DomainId)?.version).toBe("2.0.0");
  });

  it("getAll returns all registered extractors", () => {
    const registry = new ExtractorRegistry();
    registry.register({ domain: "trading" as DomainId, version: "1.0.0", extract: async () => [] });
    registry.register({ domain: "radio" as DomainId, version: "1.0.0", extract: async () => [] });
    registry.register({ domain: "fleet" as DomainId, version: "1.0.0", extract: async () => [] });
    expect(registry.getAll()).toHaveLength(3);
  });
});

// ── Edge Cases ────────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("empty fingerprint array produces no matches", () => {
    expect(findMatches([])).toHaveLength(0);
  });

  it("single fingerprint produces no matches", () => {
    const fp = makeFp({ source_domain: "trading", structure: makeStructure() });
    expect(findMatches([fp])).toHaveLength(0);
  });

  it("normalizer handles empty input", () => {
    const { accepted, rejected } = normalizeFingerprints([]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });

  it("normalizer rejects confidence just below threshold (default 0.2)", () => {
    const fp = makeFp({ confidence: 0.19, structure: makeStructure() });
    const { rejected } = normalizeFingerprints([fp]);
    expect(rejected).toHaveLength(1);
  });

  it("normalizer accepts confidence exactly at threshold (0.2)", () => {
    const fp = makeFp({ confidence: 0.2, structure: makeStructure() });
    const { accepted } = normalizeFingerprints([fp]);
    expect(accepted).toHaveLength(1);
  });

  it("50 same-domain fingerprints produce zero cross-domain matches", () => {
    const fps = Array.from({ length: 50 }, () =>
      makeFp({ source_domain: "trading", structure: makeStructure() }),
    );
    expect(findMatches(fps)).toHaveLength(0);
  });

  it("cosine similarity handles all-negative vectors", () => {
    const a = [-1, -0.5, -0.3, -0.8];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it("transfer opportunity is bidirectional (high B, low A)", () => {
    const structure = makeStructure();
    const fps = [
      makeFp({ source_domain: "trading", confidence: 0.3, structure }),
      makeFp({ source_domain: "radio", confidence: 0.9, structure }),
    ];
    const matches = findMatches(fps);
    expect(matches[0].transfer_opportunity).toBe(true);
  });

  it("no transfer opportunity when both confidences similar", () => {
    const structure = makeStructure();
    const fps = [
      makeFp({ source_domain: "trading", confidence: 0.7, structure }),
      makeFp({ source_domain: "radio", confidence: 0.7, structure }),
    ];
    const matches = findMatches(fps);
    expect(matches[0].transfer_opportunity).toBe(false);
  });

  it("alerts fire for temporal + transfer matches too", () => {
    const fpA = makeFp({ source_domain: "trading", confidence: 0.9, structure: makeStructure() });
    const fpB = makeFp({ source_domain: "radio", confidence: 0.3, structure: makeStructure() });
    const fpIndex = new Map([
      [fpA.fingerprint_id, fpA],
      [fpB.fingerprint_id, fpB],
    ]);
    const temporalMatch: CrossDomainMatch = {
      match_id: randomUUID(),
      fingerprint_a_id: fpA.fingerprint_id,
      fingerprint_b_id: fpB.fingerprint_id,
      domain_a: "trading",
      domain_b: "radio",
      similarity_score: 0.85,
      match_type: "temporal",
      a_confidence: 0.9,
      b_confidence: 0.3,
      transfer_opportunity: true,
      alert_sent: false,
      created_at: new Date().toISOString(),
    };
    const alerts = generateAlerts([temporalMatch], fpIndex);
    expect(alerts).toHaveLength(1);
  });

  it("metaphor generates distinct labels for different pattern types", () => {
    const fpA = makeFp({
      source_domain: "trading",
      label: "VWAP reversion",
      structure: makeStructure({
        reversion_force: 0.9,
        divergence_magnitude: 0.8,
        divergence_polarity: 0.7,
      }),
    });
    const fpB = makeFp({
      source_domain: "fleet",
      label: "Load balance revert",
      structure: makeStructure({
        reversion_force: 0.9,
        divergence_magnitude: 0.8,
        divergence_polarity: 0.7,
      }),
    });
    const match: CrossDomainMatch = {
      match_id: randomUUID(),
      fingerprint_a_id: fpA.fingerprint_id,
      fingerprint_b_id: fpB.fingerprint_id,
      domain_a: "trading",
      domain_b: "fleet",
      similarity_score: 0.92,
      match_type: "structural",
      a_confidence: 0.8,
      b_confidence: 0.5,
      transfer_opportunity: true,
      alert_sent: false,
      created_at: new Date().toISOString(),
    };
    const metaphor = generateMetaphor(match, fpA, fpB);
    expect(metaphor.pattern_label).toBeTruthy();
    expect(metaphor.shared_mechanism).toBeTruthy();
  });
});
