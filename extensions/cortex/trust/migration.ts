/**
 * Migration 010 — Earned Autonomy tables
 * Cortex Phase 5.6
 *
 * Creates: decision_log, trust_scores, trust_overrides, trust_milestones,
 *          pending_outcomes, pending_confirmations
 * Bootstraps trust_scores with initial values for all known categories.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { DEFAULT_TRUST_CONFIG, KNOWN_CATEGORIES } from "./types.js";

export function runMigration(db: Database.Database): void {
  db.exec(`
    -- Decision log: every autonomous decision
    CREATE TABLE IF NOT EXISTS decision_log (
      decision_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_params_hash TEXT NOT NULL,
      tool_params_summary TEXT NOT NULL,
      risk_tier INTEGER NOT NULL CHECK (risk_tier IN (1,2,3,4)),
      category TEXT NOT NULL,
      gate_decision TEXT NOT NULL CHECK (gate_decision IN ('pass','pause','block')),
      trust_score_at_decision REAL NOT NULL,
      override_active INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK (outcome IN ('pass','corrected_minor','corrected_significant',
                            'tool_error_helios','tool_error_external','denied_by_matthew','pending')),
      outcome_source TEXT,
      outcome_resolved_at TEXT,
      correction_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dl_category ON decision_log(category);
    CREATE INDEX IF NOT EXISTS idx_dl_timestamp ON decision_log(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_dl_outcome ON decision_log(outcome);
    CREATE INDEX IF NOT EXISTS idx_dl_pending ON decision_log(outcome) WHERE outcome = 'pending';

    -- Trust scores: current EWMA score per category
    CREATE TABLE IF NOT EXISTS trust_scores (
      score_id TEXT PRIMARY KEY,
      category TEXT UNIQUE NOT NULL,
      risk_tier INTEGER NOT NULL,
      current_score REAL NOT NULL CHECK (current_score BETWEEN 0.0 AND 1.0),
      ewma_alpha REAL NOT NULL DEFAULT 0.1,
      decision_count INTEGER NOT NULL DEFAULT 0,
      decisions_last_30d INTEGER NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      initial_score REAL NOT NULL
    );

    -- Trust overrides: Matthew's explicit grants/revokes
    CREATE TABLE IF NOT EXISTS trust_overrides (
      override_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      override_type TEXT NOT NULL CHECK (override_type IN ('granted','revoked')),
      reason TEXT NOT NULL,
      granted_by TEXT NOT NULL DEFAULT 'matthew',
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      revoked_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_to_category ON trust_overrides(category, active);

    -- Milestones: notable trust transitions
    CREATE TABLE IF NOT EXISTS trust_milestones (
      milestone_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      category TEXT NOT NULL,
      milestone_type TEXT NOT NULL,
      old_score REAL,
      new_score REAL NOT NULL,
      trigger TEXT NOT NULL,
      synapse_notified INTEGER NOT NULL DEFAULT 0
    );

    -- Pending outcomes: feedback window timers (survive restarts)
    CREATE TABLE IF NOT EXISTS pending_outcomes (
      decision_id TEXT PRIMARY KEY,
      feedback_window_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Pending confirmations: pause queue
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_params_json TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      trust_score REAL NOT NULL,
      threshold REAL NOT NULL,
      category TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolution TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Bootstrap trust_scores for all known categories (idempotent)
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO trust_scores (score_id, category, risk_tier, current_score, ewma_alpha, decision_count, decisions_last_30d, initial_score)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
  );

  const config = DEFAULT_TRUST_CONFIG;
  for (const { category, tier } of KNOWN_CATEGORIES) {
    const initialScore = config.initial_scores[tier] ?? 0.55;
    const alpha = config.ewma_alphas[tier] ?? 0.1;
    insertStmt.run(randomUUID(), category, tier, initialScore, alpha, initialScore);
  }
}
