/**
 * OverrideManager — Grant/revoke trust overrides
 * Earned Autonomy Phase 5.6
 *
 * Only callable from interactive sessions (Matthew's commands).
 * Agent self-grant is blocked by session_id validation.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { OverrideType, TrustOverride } from "./types.js";
import { MilestoneDetector } from "./milestone-detector.js";

export class OverrideManager {
  private milestones: MilestoneDetector;

  constructor(private db: Database.Database) {
    this.milestones = new MilestoneDetector(db);
  }

  /**
   * Validate that the caller is an interactive session (Matthew's direct command),
   * not a pipeline subagent or isolated background session.
   *
   * H1 mitigation: prevents pipeline subagents from self-granting trust overrides.
   * Pattern-matches session IDs that look like background/automated sessions.
   */
  private isInteractiveSession(sessionId: string): boolean {
    const PIPELINE_PATTERNS = [
      /^pipeline-/i,
      /^subagent-/i,
      /^isolated-/i,
      /^cron-/i,
      /^background-/i,
    ];
    return !PIPELINE_PATTERNS.some((p) => p.test(sessionId));
  }

  /**
   * Grant or revoke a trust override for a category.
   *
   * @param category  - Action category to override
   * @param type      - "granted" or "revoked"
   * @param reason    - Human-readable reason for audit trail
   * @param callerSessionId - Session ID of the caller (must be an interactive session)
   * @param expiresIn - Optional duration string like "4h", "30m", "7d" (null = permanent)
   *
   * H1 mitigation: callerSessionId is validated to reject pipeline/subagent sessions.
   * The ~/bin/trust-grant CLI passes process.env.OPENCLAW_SESSION_ID as callerSessionId.
   */
  setOverride(
    category: string,
    type: OverrideType,
    reason: string,
    callerSessionId: string,
    expiresIn: string | null = null,
  ): TrustOverride {
    // H1: reject override attempts from non-interactive (pipeline/subagent) sessions
    if (!this.isInteractiveSession(callerSessionId)) {
      throw new Error(
        `OverrideManager.setOverride() rejected: caller session '${callerSessionId}' is not ` +
          `an interactive session. Trust overrides require Matthew's explicit authorization ` +
          `from an interactive (non-pipeline) session.`,
      );
    }

    // Deactivate any existing override for this category
    this.db
      .prepare(
        `UPDATE trust_overrides SET active = 0, revoked_at = datetime('now')
         WHERE category = ? AND active = 1`,
      )
      .run(category);

    const expiresAt = expiresIn ? this.parseExpiry(expiresIn) : null;

    const override: TrustOverride = {
      override_id: randomUUID(),
      category,
      override_type: type,
      reason,
      granted_by: "matthew",
      granted_at: new Date().toISOString(),
      expires_at: expiresAt,
      revoked_at: null,
      active: true,
    };

    this.db
      .prepare(
        `INSERT INTO trust_overrides (override_id, category, override_type, reason, granted_by, expires_at, active)
         VALUES (?, ?, ?, ?, 'matthew', ?, 1)`,
      )
      .run(
        override.override_id,
        override.category,
        override.override_type,
        override.reason,
        override.expires_at,
      );

    // Record milestone
    const scoreRow = this.db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = ?`)
      .get(category) as { current_score: number } | undefined;

    const milestoneType = type === "granted" ? "override_granted" : "override_revoked";
    this.milestones.recordOverrideMilestone(
      category,
      milestoneType as "override_granted" | "override_revoked",
      scoreRow?.current_score ?? 0,
      reason,
    );

    return override;
  }

  /**
   * Revoke all active overrides.
   */
  revokeAll(): number {
    const result = this.db
      .prepare(
        `UPDATE trust_overrides SET active = 0, revoked_at = datetime('now')
         WHERE active = 1`,
      )
      .run();
    return result.changes;
  }

  /**
   * List active overrides.
   */
  listActive(): TrustOverride[] {
    return this.db
      .prepare(
        `SELECT * FROM trust_overrides
         WHERE active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .all() as TrustOverride[];
  }

  private parseExpiry(duration: string): string {
    const match = duration.match(/^(\d+)(m|h|d)$/);
    if (!match) throw new Error(`Invalid duration format: ${duration}. Use e.g. "30m", "4h", "7d"`);

    const value = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === "m" ? value * 60000 : unit === "h" ? value * 3600000 : value * 86400000;

    return new Date(Date.now() + ms).toISOString();
  }
}
