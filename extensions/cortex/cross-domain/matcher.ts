/**
 * Task-009: Cross-Domain Pattern Transfer — Matcher + Classifier
 *
 * Computes pairwise cosine similarity on PatternFingerprint structural vectors
 * across different domains. Classifies matches as structural, causal, or temporal.
 */

import { randomUUID } from "node:crypto";
import type { CDPTConfig, CrossDomainMatch, MatchType, PatternFingerprint } from "./types.js";
import { DEFAULT_CONFIG, STRUCTURAL_DIMENSIONS, TEMPORAL_DIMENSIONS } from "./types.js";

// ── Vector Math ───────────────────────────────────────────────────

/** Extract the 12-dim vector as a number array */
function toVector(fp: PatternFingerprint): number[] {
  return STRUCTURAL_DIMENSIONS.map((d) => fp.structure[d]);
}

/** Extract temporal subset vector */
function toTemporalVector(fp: PatternFingerprint): number[] {
  return TEMPORAL_DIMENSIONS.map((d) => fp.structure[d]);
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ── Classifier ────────────────────────────────────────────────────

/** Simple atom index for checking if a fingerprint has atom backing */
export type AtomIndex = Set<string>; // source_ids that have atom records

export function classifyMatch(
  a: PatternFingerprint,
  b: PatternFingerprint,
  _sim: number,
  atomIndex: AtomIndex,
  config: CDPTConfig = DEFAULT_CONFIG,
): MatchType {
  const temporalSim = cosineSimilarity(toTemporalVector(a), toTemporalVector(b));
  if (temporalSim > config.temporal_threshold) return "temporal";

  const hasAtomA = atomIndex.has(a.source_id);
  const hasAtomB = atomIndex.has(b.source_id);
  if (hasAtomA && hasAtomB) return "causal";

  return "structural";
}

// ── Matcher ───────────────────────────────────────────────────────

export interface MatcherOptions {
  config?: CDPTConfig;
  atomIndex?: AtomIndex;
  /** Existing match pairs to skip (Set of "fpA_id|fpB_id") */
  existingPairs?: Set<string>;
}

/**
 * Find cross-domain matches above the similarity threshold.
 * Only compares fingerprints from DIFFERENT domains.
 * Returns deduplicated matches (A-B, not also B-A).
 */
export function findMatches(
  fingerprints: PatternFingerprint[],
  opts: MatcherOptions = {},
): CrossDomainMatch[] {
  const config = opts.config ?? DEFAULT_CONFIG;
  const atomIndex = opts.atomIndex ?? new Set<string>();
  const existingPairs = opts.existingPairs ?? new Set<string>();
  const now = new Date().toISOString();
  const matches: CrossDomainMatch[] = [];

  // Group by domain for cross-domain-only comparison
  const byDomain = new Map<string, PatternFingerprint[]>();
  for (const fp of fingerprints) {
    const arr = byDomain.get(fp.source_domain) ?? [];
    arr.push(fp);
    byDomain.set(fp.source_domain, arr);
  }

  const domains = [...byDomain.keys()];

  // Compare each domain pair
  for (let di = 0; di < domains.length; di++) {
    for (let dj = di + 1; dj < domains.length; dj++) {
      const fpsA = byDomain.get(domains[di])!;
      const fpsB = byDomain.get(domains[dj])!;

      for (const a of fpsA) {
        const vecA = toVector(a);
        for (const b of fpsB) {
          // Idempotency check
          const pairKey =
            a.fingerprint_id < b.fingerprint_id
              ? `${a.fingerprint_id}|${b.fingerprint_id}`
              : `${b.fingerprint_id}|${a.fingerprint_id}`;
          if (existingPairs.has(pairKey)) continue;

          const sim = cosineSimilarity(vecA, toVector(b));
          if (sim < config.match_threshold) continue;

          const matchType = classifyMatch(a, b, sim, atomIndex, config);
          const transferOpp =
            (a.confidence >= 0.8 && b.confidence < 0.6) ||
            (b.confidence >= 0.8 && a.confidence < 0.6);

          matches.push({
            match_id: randomUUID(),
            fingerprint_a_id:
              a.fingerprint_id < b.fingerprint_id ? a.fingerprint_id : b.fingerprint_id,
            fingerprint_b_id:
              a.fingerprint_id < b.fingerprint_id ? b.fingerprint_id : a.fingerprint_id,
            domain_a: a.fingerprint_id < b.fingerprint_id ? a.source_domain : b.source_domain,
            domain_b: a.fingerprint_id < b.fingerprint_id ? b.source_domain : a.source_domain,
            similarity_score: sim,
            match_type: matchType,
            a_confidence: a.confidence,
            b_confidence: b.confidence,
            transfer_opportunity: transferOpp,
            alert_sent: false,
            created_at: now,
          });

          existingPairs.add(pairKey);
        }
      }
    }
  }

  return matches;
}
