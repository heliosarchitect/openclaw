/**
 * Real-Time Learning — Database Schema & Migrations
 * Cortex v2.6.0 (task-011)
 *
 * Adds failure_events, propagation_records, regression_tests tables to brain.db
 */

import type { RealtimeLearningDB } from "./types.js";

const MIGRATIONS: string[] = [
  // Table 1: failure_events
  `CREATE TABLE IF NOT EXISTS failure_events (
    id                TEXT PRIMARY KEY,
    detected_at       TEXT NOT NULL DEFAULT (datetime('now')),
    type              TEXT NOT NULL,
    tier              INTEGER NOT NULL,
    source            TEXT NOT NULL,
    context           TEXT NOT NULL DEFAULT '{}',
    raw_input         TEXT,
    failure_desc      TEXT NOT NULL,
    root_cause        TEXT,
    propagation_status TEXT NOT NULL DEFAULT 'pending',
    recurrence_count  INTEGER NOT NULL DEFAULT 0,
    last_recurred_at  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fe_type     ON failure_events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_fe_tier     ON failure_events(tier)`,
  `CREATE INDEX IF NOT EXISTS idx_fe_detected ON failure_events(detected_at)`,
  `CREATE INDEX IF NOT EXISTS idx_fe_root     ON failure_events(root_cause)`,

  // Table 2: propagation_records
  `CREATE TABLE IF NOT EXISTS propagation_records (
    id                TEXT PRIMARY KEY,
    failure_id        TEXT NOT NULL REFERENCES failure_events(id),
    started_at        TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at      TEXT,
    propagation_type  TEXT NOT NULL,
    target_file       TEXT,
    commit_sha        TEXT,
    synapse_msg_id    TEXT,
    preview_sent_at   TEXT,
    matthew_approved  INTEGER,
    status            TEXT NOT NULL DEFAULT 'pending',
    diff_preview      TEXT,
    error_detail      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pr_failure ON propagation_records(failure_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pr_status  ON propagation_records(status)`,

  // Table 3: regression_tests
  `CREATE TABLE IF NOT EXISTS regression_tests (
    id           TEXT PRIMARY KEY,
    failure_id   TEXT NOT NULL REFERENCES failure_events(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_run_at  TEXT,
    description  TEXT NOT NULL,
    test_file    TEXT,
    pass_count   INTEGER NOT NULL DEFAULT 0,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    last_result  TEXT,
    active       INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rt_failure ON regression_tests(failure_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rt_active  ON regression_tests(active)`,
];

export async function runRealtimeLearningMigrations(db: RealtimeLearningDB): Promise<void> {
  for (const sql of MIGRATIONS) {
    await db.run(sql);
  }
}
