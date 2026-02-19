/**
 * Migration 008: Knowledge Compression schema additions
 *
 * Adds compression_log table and extends memories table
 * with compressed_from and archived_by columns.
 */
import type { CortexBridge } from "../cortex-bridge.js";

export async function runMigration008(bridge: CortexBridge): Promise<void> {
  // Create compression_log table
  await bridge.runSQL(`
    CREATE TABLE IF NOT EXISTS compression_log (
      id TEXT PRIMARY KEY,
      cluster_fingerprint TEXT NOT NULL,
      compressed_memory_id TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      member_count INTEGER NOT NULL,
      compression_ratio REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await bridge.runSQL(`
    CREATE INDEX IF NOT EXISTS idx_compression_log_fingerprint
    ON compression_log(cluster_fingerprint)
  `);

  await bridge.runSQL(`
    CREATE INDEX IF NOT EXISTS idx_compression_log_created
    ON compression_log(created_at)
  `);

  // Add columns to memories table (SQLite ALTER TABLE ADD COLUMN is safe if column exists — it errors, so we catch)
  try {
    await bridge.runSQL(`ALTER TABLE memories ADD COLUMN compressed_from TEXT`);
  } catch {
    // Column already exists
  }

  try {
    await bridge.runSQL(`ALTER TABLE memories ADD COLUMN archived_by TEXT`);
  } catch {
    // Column already exists
  }
}
