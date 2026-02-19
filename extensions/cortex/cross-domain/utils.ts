/**
 * Task-009: Cross-Domain Pattern Transfer — Shared Security Utilities
 *
 * Path validation and shell-safety helpers.
 * SEC-002, SEC-003: Prevent shell injection and brain.db misdirection.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Validate that a database path contains no shell metacharacters.
 * Throws if the path is unsafe; returns the resolved absolute path if safe.
 */
export function validateDbPath(rawPath: string, description = "DB"): string {
  const resolved = resolve(rawPath);
  // Reject paths containing shell metacharacters
  if (/[;&|`$(){}[\]<>\\!]/.test(resolved)) {
    throw new Error(
      `[CDPT] Unsafe ${description} path rejected (contains shell metacharacters): ${rawPath}`,
    );
  }
  return resolved;
}

/**
 * Ensure a DB path is NOT pointing at brain.db.
 * Prevents AUGUR_DB_PATH from being redirected to Cortex's own memory store.
 */
export function assertNotBrainDb(dbPath: string): void {
  const brainDb = resolve(`${homedir()}/.openclaw/workspace/memory/brain.db`);
  if (resolve(dbPath) === brainDb) {
    throw new Error(
      `[CDPT] Refusing to use brain.db as a domain data source. Set AUGUR_DB_PATH to the AUGUR signals database.`,
    );
  }
}
