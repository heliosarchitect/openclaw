/**
 * MilestoneDetector — Detect notable trust score transitions
 * Earned Autonomy Phase 5.6
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MilestoneType, RiskTier, TrustConfig, TrustMilestone } from "./types.js";
import { DEFAULT_TRUST_CONFIG } from "./types.js";

export class MilestoneDetector {
  private config: TrustConfig;

  constructor(
    private db: Database.Database,
    config?: Partial<TrustConfig>,
  ) {
    this.config = { ...DEFAULT_TRUST_CONFIG, ...config };
  }

  /**
   * Check for milestones after a score change.
   * Returns any milestones that were created.
   */
  check(category: string, tier: RiskTier, oldScore: number, newScore: number): TrustMilestone[] {
    const threshold = this.config.tier_thresholds[tier] ?? 0.7;
    const floor = this.config.tier_floors[tier] ?? 0.4;
    const milestones: TrustMilestone[] = [];

    // Crossed threshold upward
    if (oldScore < threshold && newScore >= threshold) {
      const hasHistory = this.db
        .prepare(
          `SELECT 1 FROM trust_milestones
           WHERE category = ? AND milestone_type IN ('first_auto_approve', 'tier_promotion')
           LIMIT 1`,
        )
        .get(category);

      const type: MilestoneType = hasHistory ? "tier_promotion" : "first_auto_approve";
      milestones.push(
        this.createMilestone(
          category,
          type,
          oldScore,
          newScore,
          `Score crossed threshold ${threshold}`,
        ),
      );
    }

    // Crossed threshold downward (demotion)
    if (oldScore >= threshold && newScore < threshold) {
      milestones.push(
        this.createMilestone(
          category,
          "tier_demotion",
          oldScore,
          newScore,
          `Score dropped below threshold ${threshold}`,
        ),
      );
    }

    // Crossed floor downward (blocked)
    if (oldScore >= floor && newScore < floor) {
      milestones.push(
        this.createMilestone(
          category,
          "blocked",
          oldScore,
          newScore,
          `Score dropped below floor ${floor} — autonomous action suspended`,
        ),
      );
    }

    return milestones;
  }

  /**
   * Record an override milestone (grant or revoke).
   */
  recordOverrideMilestone(
    category: string,
    type: "override_granted" | "override_revoked",
    currentScore: number,
    reason: string,
  ): TrustMilestone {
    return this.createMilestone(category, type, null, currentScore, reason);
  }

  private createMilestone(
    category: string,
    type: MilestoneType,
    oldScore: number | null,
    newScore: number,
    trigger: string,
  ): TrustMilestone {
    const milestone: TrustMilestone = {
      milestone_id: randomUUID(),
      timestamp: new Date().toISOString(),
      category,
      milestone_type: type,
      old_score: oldScore,
      new_score: newScore,
      trigger,
      synapse_notified: false,
    };

    this.db
      .prepare(
        `INSERT INTO trust_milestones (milestone_id, category, milestone_type, old_score, new_score, trigger, synapse_notified)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        milestone.milestone_id,
        milestone.category,
        milestone.milestone_type,
        milestone.old_score,
        milestone.new_score,
        milestone.trigger,
      );

    return milestone;
  }
}
