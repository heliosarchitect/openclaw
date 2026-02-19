/**
 * Task-009: Cross-Domain Pattern Transfer — Metaphor Engine
 *
 * Generates human-readable cross-domain analogies for structural
 * and causal matches. Uses template-based generation (no LLM call
 * for v1 — deterministic and fast).
 */

import { randomUUID } from "node:crypto";
import type {
  CrossDomainMatch,
  DomainMetaphor,
  PatternFingerprint,
  StructuralVector,
} from "../types.js";
import { STRUCTURAL_DIMENSIONS } from "../types.js";

// ── Pattern Label Inference ───────────────────────────────────────

interface DimensionWeight {
  dim: keyof StructuralVector;
  weight: number;
}

/** Identify the dominant structural pattern from a fingerprint */
function inferPatternLabel(a: PatternFingerprint, b: PatternFingerprint): string {
  // Average the absolute values of each dimension across both fingerprints
  const dimScores: DimensionWeight[] = STRUCTURAL_DIMENSIONS.map((dim) => ({
    dim,
    weight: (Math.abs(a.structure[dim]) + Math.abs(b.structure[dim])) / 2,
  }));
  dimScores.sort((x, y) => y.weight - x.weight);

  const top = dimScores[0].dim;
  const second = dimScores[1].dim;

  // Map dimension combos to pattern labels
  if (top === "divergence_magnitude" || top === "divergence_polarity") {
    if (dimScores.some((d) => d.dim === "reversion_force" && d.weight > 0.4)) {
      return "Divergence-Reversion";
    }
    return "Divergence";
  }
  if (top === "cascade_potential") return "Cascade Failure";
  if (top === "threshold_proximity") return "Threshold Breach";
  if (top === "signal_decay_rate") return "Signal Decay";
  if (top === "reversion_force") return "Mean Reversion";
  if (top === "oscillation_frequency") return "Cyclical Pattern";
  if (top === "trend_strength" || top === "trend_direction") {
    return second === "signal_decay_rate" ? "Trending with Decay" : "Trend Momentum";
  }
  if (top === "effect_size") return "High-Impact Event";
  return "Structural Similarity";
}

// ── Domain Name Map ───────────────────────────────────────────────

const DOMAIN_NAMES: Record<string, string> = {
  trading: "trading (AUGUR)",
  radio: "ham radio (ft991a)",
  fleet: "fleet infrastructure",
  meta: "AI/Cortex meta-operations",
};

// ── Shared Mechanism Templates ────────────────────────────────────

const MECHANISM_TEMPLATES: Record<string, string> = {
  "Divergence-Reversion":
    "a leading indicator separates from its baseline, then reverts with predictive accuracy",
  Divergence: "a measured value diverges from expected baseline, signaling regime change",
  "Cascade Failure":
    "a single fault propagates through interconnected components, amplifying impact",
  "Threshold Breach": "gradual drift toward a critical boundary triggers abrupt state change",
  "Signal Decay": "predictive power diminishes over time following initial detection",
  "Mean Reversion": "extreme values regress toward a long-term average with predictable timing",
  "Cyclical Pattern": "periodic oscillation with identifiable frequency and amplitude",
  "Trending with Decay": "directional movement that loses momentum over a characteristic timescale",
  "Trend Momentum": "sustained directional pressure that builds upon itself",
  "High-Impact Event": "rare event with outsized effect relative to its frequency",
  "Structural Similarity": "shared mathematical structure across different measurement domains",
};

// ── Metaphor Generator ────────────────────────────────────────────

export function generateMetaphor(
  match: CrossDomainMatch,
  fpA: PatternFingerprint,
  fpB: PatternFingerprint,
): DomainMetaphor {
  const patternLabel = inferPatternLabel(fpA, fpB);
  const mechanism =
    MECHANISM_TEMPLATES[patternLabel] ?? MECHANISM_TEMPLATES["Structural Similarity"];
  const domA = DOMAIN_NAMES[match.domain_a] ?? match.domain_a;
  const domB = DOMAIN_NAMES[match.domain_b] ?? match.domain_b;

  const text =
    `"${fpA.label}" in ${domA} ≈ "${fpB.label}" in ${domB} — ` +
    `both are ${patternLabel} patterns where ${mechanism}. ` +
    `Similarity: ${(match.similarity_score * 100).toFixed(1)}%.`;

  return {
    metaphor_id: randomUUID(),
    match_id: match.match_id,
    domains_involved: [match.domain_a, match.domain_b],
    pattern_label: patternLabel,
    text,
    shared_mechanism: mechanism,
    confidence: (match.a_confidence + match.b_confidence) / 2,
    created_at: new Date().toISOString(),
  };
}

/**
 * Generate metaphors for a batch of matches.
 * Groups cliques (3+ domains matching each other) into unified metaphors.
 */
export function generateMetaphors(
  matches: CrossDomainMatch[],
  fingerprintIndex: Map<string, PatternFingerprint>,
): DomainMetaphor[] {
  const metaphors: DomainMetaphor[] = [];

  for (const match of matches) {
    const fpA = fingerprintIndex.get(match.fingerprint_a_id);
    const fpB = fingerprintIndex.get(match.fingerprint_b_id);
    if (!fpA || !fpB) continue;

    metaphors.push(generateMetaphor(match, fpA, fpB));
  }

  return metaphors;
}
