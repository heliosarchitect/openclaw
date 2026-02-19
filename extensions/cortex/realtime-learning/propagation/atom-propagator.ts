/**
 * Real-Time Learning — Atom Propagator
 * Cortex v2.6.0 (task-011)
 *
 * Creates atoms documenting failure → fix causal chains.
 * Enables atom_find_causes to trace recurring issues to root.
 */

import type { RealtimeLearningDB } from "../types.js";
import type { FailureEvent, PropagationTarget } from "../types.js";

export class AtomPropagator {
  private db: RealtimeLearningDB;
  private logger?: { debug?: (msg: string) => void };

  constructor(db: RealtimeLearningDB, logger?: { debug?: (msg: string) => void }) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Record a failure→fix atom in the atoms table (if it exists).
   * Falls back to a propagation_records entry if atoms table isn't available.
   */
  async propagate(
    failure: FailureEvent,
    targets: PropagationTarget[],
  ): Promise<{ success: boolean; detail: string }> {
    try {
      // Check if atoms table exists (from task-008 knowledge compression)
      const table = await this.db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='atoms'",
      );

      if (table) {
        const id = this.generateId();
        const now = new Date().toISOString();
        await this.db.run(
          `INSERT INTO atoms (id, subject, action, outcome, consequences, confidence, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            `failure:${failure.type}:${failure.id.substring(0, 8)}`,
            `triggered by ${failure.root_cause ?? "unknown"} in ${failure.source}`,
            `propagated to ${targets.join(", ")}`,
            `regression armed; recurrence detection active`,
            0.8,
            "realtime-learning",
            now,
          ],
        );

        this.logger?.debug?.(`[AtomPropagator] Created atom ${id} for failure ${failure.id}`);
        return { success: true, detail: `atom:${id}` };
      }

      // No atoms table — record in propagation_records only
      this.logger?.debug?.(`[AtomPropagator] No atoms table — skipping atom creation`);
      return { success: true, detail: "atoms_table_unavailable" };
    } catch (err) {
      return { success: false, detail: `${err}` };
    }
  }

  private generateId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
