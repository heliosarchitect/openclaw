/**
 * Task-009: Cross-Domain Pattern Transfer — Database Migration
 *
 * Creates tables: cross_domain_patterns, cross_domain_matches, domain_metaphors
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";

const MIGRATION_SQL = `
-- Cross-Domain Pattern Transfer tables (task-009, cortex v2.4.0)

CREATE TABLE IF NOT EXISTS cross_domain_patterns (
  fingerprint_id TEXT PRIMARY KEY,
  source_domain TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  label TEXT NOT NULL,
  confidence REAL NOT NULL,
  structure JSON NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, source_type, run_id)
);

CREATE INDEX IF NOT EXISTS idx_cdp_domain ON cross_domain_patterns(source_domain);
CREATE INDEX IF NOT EXISTS idx_cdp_confidence ON cross_domain_patterns(confidence);
CREATE INDEX IF NOT EXISTS idx_cdp_run ON cross_domain_patterns(run_id);

CREATE TABLE IF NOT EXISTS cross_domain_matches (
  match_id TEXT PRIMARY KEY,
  fingerprint_a_id TEXT NOT NULL REFERENCES cross_domain_patterns(fingerprint_id),
  fingerprint_b_id TEXT NOT NULL REFERENCES cross_domain_patterns(fingerprint_id),
  domain_a TEXT NOT NULL,
  domain_b TEXT NOT NULL,
  similarity_score REAL NOT NULL,
  match_type TEXT NOT NULL,
  transfer_opportunity INTEGER NOT NULL DEFAULT 0,
  metaphor_id TEXT,
  hypothesis_id TEXT,
  alert_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fingerprint_a_id, fingerprint_b_id)
);

CREATE INDEX IF NOT EXISTS idx_cdm_domains ON cross_domain_matches(domain_a, domain_b);
CREATE INDEX IF NOT EXISTS idx_cdm_score ON cross_domain_matches(similarity_score DESC);

CREATE TABLE IF NOT EXISTS domain_metaphors (
  metaphor_id TEXT PRIMARY KEY,
  match_id TEXT,
  domains_involved JSON NOT NULL,
  pattern_label TEXT NOT NULL,
  text TEXT NOT NULL,
  shared_mechanism TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function runMigration(): void {
  const dbPath = `${homedir()}/.openclaw/workspace/memory/brain.db`;
  execSync(`sqlite3 "${dbPath}" "${MIGRATION_SQL.replace(/"/g, '\\"')}"`, {
    encoding: "utf-8",
    timeout: 10000,
  });
}

// Allow direct execution
if (process.argv[1]?.endsWith("migration-009.ts")) {
  runMigration();
  console.log("Migration 009 (cross-domain) complete.");
}
