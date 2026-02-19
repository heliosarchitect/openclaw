/**
 * Task-009: Cross-Domain Pattern Transfer — Types
 * Phase 5.5 of IMPROVEMENT_PLAN
 */

// ── 12-Dimensional Structural Vector ──────────────────────────────

export interface StructuralVector {
  /** -1 (falling) → +1 (rising) */
  trend_direction: number;
  /** 0 (flat) → 1 (strong) */
  trend_strength: number;
  /** 0 (monotonic) → 1 (high-freq oscillation) */
  oscillation_frequency: number;
  /** 0 (trending) → 1 (strong mean-reversion) */
  reversion_force: number;

  /** 0 (no divergence) → 1 (maximum separation) */
  divergence_magnitude: number;
  /** -1 (converging) → +1 (diverging) */
  divergence_polarity: number;

  /** 0 (far from threshold) → 1 (at threshold) */
  threshold_proximity: number;
  /** 0 (isolated) → 1 (high cascade risk) */
  cascade_potential: number;

  /** 0 (persistent) → 1 (fast-decaying) */
  signal_decay_rate: number;
  /** 0 (coincident) → 1 (long lead time) */
  lead_time_normalized: number;

  /** 0 (weak) → 1 (large effect) */
  effect_size: number;
  /** 0 (rare) → 1 (frequent) */
  frequency_of_occurrence: number;
}

export const STRUCTURAL_DIMENSIONS = [
  "trend_direction",
  "trend_strength",
  "oscillation_frequency",
  "reversion_force",
  "divergence_magnitude",
  "divergence_polarity",
  "threshold_proximity",
  "cascade_potential",
  "signal_decay_rate",
  "lead_time_normalized",
  "effect_size",
  "frequency_of_occurrence",
] as const;

export const TEMPORAL_DIMENSIONS: (keyof StructuralVector)[] = [
  "signal_decay_rate",
  "lead_time_normalized",
  "oscillation_frequency",
];

export type DomainId = "trading" | "radio" | "fleet" | "meta";
export type SourceType = "atom" | "memory" | "signal" | "event";
export type MatchType = "structural" | "causal" | "temporal";
export type AlertUrgency = "info" | "action";

// ── Pattern Fingerprint ───────────────────────────────────────────

export interface PatternFingerprint {
  fingerprint_id: string;
  source_domain: DomainId;
  source_id: string;
  source_type: SourceType;
  label: string;
  confidence: number;
  structure: StructuralVector;
  created_at: string;
  run_id: string;
}

// ── Cross-Domain Match ────────────────────────────────────────────

export interface CrossDomainMatch {
  match_id: string;
  fingerprint_a_id: string;
  fingerprint_b_id: string;
  domain_a: DomainId;
  domain_b: DomainId;
  similarity_score: number;
  match_type: MatchType;
  a_confidence: number;
  b_confidence: number;
  transfer_opportunity: boolean;
  metaphor_id?: string;
  hypothesis_id?: string;
  alert_sent: boolean;
  created_at: string;
}

// ── Domain Metaphor ───────────────────────────────────────────────

export interface DomainMetaphor {
  metaphor_id: string;
  match_id: string | null;
  domains_involved: DomainId[];
  pattern_label: string;
  text: string;
  shared_mechanism: string;
  confidence: number;
  created_at: string;
}

// ── Cross-Pollination Alert ───────────────────────────────────────

export interface CrossPollinationAlert {
  alert_id: string;
  match_id: string;
  source_domain: DomainId;
  source_pattern: string;
  source_confidence: number;
  source_win_rate?: number;
  target_domain: DomainId;
  target_pattern: string;
  target_confidence: number;
  transfer_recommendation: string;
  urgency: AlertUrgency;
  created_at: string;
}

// ── Hypothesis ────────────────────────────────────────────────────

export interface CrossDomainHypothesis {
  hypothesis_id: string;
  match_id: string;
  text: string;
  source_domain: DomainId;
  target_domain: DomainId;
  status: "unvalidated" | "validated" | "falsified";
  confidence: number;
  created_at: string;
}

// ── Extractor Interface ───────────────────────────────────────────

export interface ExtractOptions {
  run_id: string;
  since?: string; // ISO timestamp — only extract newer records
  limit?: number;
}

export interface DomainExtractor {
  readonly domain: DomainId;
  readonly version: string;
  extract(options: ExtractOptions): Promise<PatternFingerprint[]>;
}

// ── Extractor Registry ────────────────────────────────────────────

export interface ExtractorRegistryI {
  register(extractor: DomainExtractor): void;
  getAll(): DomainExtractor[];
  getByDomain(domain: DomainId): DomainExtractor | undefined;
}

// ── CDPT Run Report ───────────────────────────────────────────────

export interface CDPTRunReport {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;

  extractors_run: number;
  fingerprints_created: number;
  fingerprints_rejected: number;

  matches_found: number;
  matches_structural: number;
  matches_causal: number;
  matches_temporal: number;

  metaphors_generated: number;
  alerts_fired: number;
  hypotheses_generated: number;

  errors: CDPTError[];
  verdict: "PASS" | "PARTIAL" | "FAIL";
}

export interface CDPTError {
  stage: "extract" | "normalize" | "match" | "synthesize" | "report";
  extractor?: string;
  message: string;
  timestamp: string;
}

// ── Config ────────────────────────────────────────────────────────

export interface CDPTConfig {
  match_threshold: number; // cosine similarity threshold (default 0.75)
  temporal_threshold: number; // temporal classification threshold (default 0.88)
  max_hypotheses_per_run: number; // cap (default 10)
  bootstrap_confidence: number; // confidence floor for sparse domains (default 0.3)
  min_confidence: number; // reject below this (default 0.2)
  max_zero_dimensions: number; // reject if more zeros than this (default 6)
  idempotency_days: number; // skip match pairs seen within N days (default 30)
  enabled_extractors?: DomainId[]; // if set, only run these
}

export const DEFAULT_CONFIG: CDPTConfig = {
  match_threshold: 0.75,
  temporal_threshold: 0.88,
  max_hypotheses_per_run: 10,
  bootstrap_confidence: 0.3,
  min_confidence: 0.2,
  max_zero_dimensions: 6,
  idempotency_days: 30,
};
