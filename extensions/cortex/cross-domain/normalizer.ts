/**
 * Task-009: Cross-Domain Pattern Transfer — Pattern Normalizer
 *
 * Receives raw extractor output, validates, and normalizes all 12 dimensions
 * to [-1, 1] range. Rejects under-specified or low-confidence fingerprints.
 */

import type { CDPTConfig, PatternFingerprint, StructuralVector } from "./types.js";
import { DEFAULT_CONFIG, STRUCTURAL_DIMENSIONS } from "./types.js";

export interface NormalizationResult {
  accepted: PatternFingerprint[];
  rejected: Array<{ fingerprint: PatternFingerprint; reason: string }>;
}

/** Clip a value to [-1, 1] */
function clip(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** Count zero dimensions in a structural vector */
function countZeros(s: StructuralVector): number {
  let count = 0;
  for (const dim of STRUCTURAL_DIMENSIONS) {
    if (Math.abs(s[dim]) < 0.001) count++;
  }
  return count;
}

/** Normalize a structural vector: clip all dimensions to [-1, 1] */
function normalizeStructure(s: StructuralVector): StructuralVector {
  const result = { ...s };
  for (const dim of STRUCTURAL_DIMENSIONS) {
    result[dim] = clip(result[dim]);
  }
  return result;
}

/**
 * Validate and normalize a batch of fingerprints.
 * Rejects: under-specified (>max_zero_dimensions zeros), low confidence (<min_confidence).
 */
export function normalizeFingerprints(
  fingerprints: PatternFingerprint[],
  config: CDPTConfig = DEFAULT_CONFIG,
): NormalizationResult {
  const accepted: PatternFingerprint[] = [];
  const rejected: NormalizationResult["rejected"] = [];

  for (const fp of fingerprints) {
    // Confidence floor
    if (fp.confidence < config.min_confidence) {
      rejected.push({
        fingerprint: fp,
        reason: `confidence ${fp.confidence} < ${config.min_confidence}`,
      });
      continue;
    }

    // Under-specified check
    const zeros = countZeros(fp.structure);
    if (zeros > config.max_zero_dimensions) {
      rejected.push({
        fingerprint: fp,
        reason: `${zeros} zero dimensions > max ${config.max_zero_dimensions}`,
      });
      continue;
    }

    // Normalize and accept
    accepted.push({
      ...fp,
      structure: normalizeStructure(fp.structure),
    });
  }

  return { accepted, rejected };
}
