/**
 * Preamble Injector — Cross-Session State Preservation
 * Cortex v2.0.0
 *
 * Formats session continuity text for injection into the first agent turn.
 */

import type { PendingTask, SessionState } from "./types.js";

export class PreambleInjector {
  /**
   * Format a session continuity preamble from scored prior sessions.
   *
   * @param sessions - Prior sessions with relevance_score set, sorted descending
   * @param inheritedPinCount - Number of pins inherited
   * @returns Formatted preamble string, or null if nothing to inject
   */
  format(sessions: SessionState[], inheritedPinCount: number): string | null {
    if (sessions.length === 0) return null;

    const lines: string[] = [];
    lines.push(`[SESSION CONTINUITY — inherited from ${sessions.length} prior session(s)]`);
    lines.push("");

    // Pending tasks (aggregated, deduplicated by task_id)
    const taskMap = new Map<string, PendingTask>();
    for (const s of sessions) {
      for (const t of s.pending_tasks) {
        if (!taskMap.has(t.task_id)) {
          taskMap.set(t.task_id, t);
        }
      }
    }

    if (taskMap.size > 0) {
      lines.push("PENDING TASKS:");
      for (const t of taskMap.values()) {
        const endTime = sessions[0].end_time;
        const daysAgo = endTime
          ? Math.round((Date.now() - new Date(endTime).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        lines.push(`- [${t.task_id}] ${t.title} (last stage: ${t.stage}, ${daysAgo}d ago)`);
      }
      lines.push("");
    }

    // Active projects (union)
    const allProjects = new Set<string>();
    for (const s of sessions) {
      for (const p of s.active_projects) {
        allProjects.add(p);
      }
    }
    if (allProjects.size > 0) {
      lines.push(`ACTIVE PROJECTS: ${[...allProjects].join(", ")}`);
      lines.push("");
    }

    // Hot topics (from highest-scoring session)
    const topTopics = sessions[0].hot_topics.slice(0, 10);
    if (topTopics.length > 0) {
      lines.push(`HOT TOPICS: ${topTopics.join(", ")}`);
      lines.push("");
    }

    if (inheritedPinCount > 0) {
      lines.push(
        `WORKING MEMORY RESTORED: ${inheritedPinCount} pins inherited (see working_memory view)`,
      );
    }

    // Only return if we have meaningful content beyond the header
    return lines.length > 2 ? lines.join("\n") : null;
  }
}
