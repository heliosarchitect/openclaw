/**
 * Task-008: Knowledge Compression — Abstraction Engine Types
 * Phase 5.4 of IMPROVEMENT_PLAN
 */

export interface MemoryCandidate {
  id: string;
  content: string;
  categories: string[];
  importance: number;
  timestamp: string;
  access_count: number;
  embedding?: number[];
}

export interface MemoryCluster {
  cluster_id: string;
  member_ids: string[];
  member_count: number;
  avg_similarity: number;
  dominant_category: string;
  total_tokens: number;
  oldest_member_at: string;
  fingerprint: string; // SHA-256 of sorted member IDs
}

export interface DistillationResult {
  abstraction: string;
  compression_ratio: number;
  is_causal: boolean;
}

export interface CompressedMemoryRecord {
  content: string;
  categories: string[];
  importance: number;
  compressed_from: string[];
  compression_ratio: number;
  cluster_size: number;
  distilled_at: string;
  source_date_range: [string, string];
}

export interface CausalAtom {
  subject: string;
  action: string;
  outcome: string;
  consequences: string;
}

export interface CompressionError {
  cluster_id: string;
  stage: "cluster" | "distill" | "write" | "archive" | "enrich";
  message: string;
  timestamp: string;
}

export interface CompressionRunReport {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;

  memories_scanned: number;
  clusters_found: number;
  clusters_skipped: number;
  clusters_compressed: number;

  memories_archived: number;
  abstractions_created: number;
  atoms_created: number;
  atoms_enriched: number;

  tokens_before: number;
  tokens_after: number;
  token_reduction_pct: number;

  avg_compression_ratio: number;
  max_compression_ratio: number;

  errors: CompressionError[];

  verdict: "PASS" | "PARTIAL" | "FAIL";
}

export interface CompressionLogEntry {
  id: string;
  cluster_fingerprint: string;
  compressed_memory_id: string | null;
  status: "compressed" | "skipped" | "failed";
  reason: string | null;
  member_count: number;
  compression_ratio: number | null;
  created_at: string;
}
