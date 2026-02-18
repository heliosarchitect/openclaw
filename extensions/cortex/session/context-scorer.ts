/**
 * Context Relevance Scorer — Cross-Session State Preservation
 * Cortex v2.0.0
 *
 * Scores prior sessions for relevance to the current context.
 * Uses recency, topic overlap, and pending task weighting.
 */

import type { SessionState } from "./types.js";

/**
 * Calculate relevance score for a prior session.
 *
 * @param session - Prior session state
 * @param currentKeywords - Keywords from current context (working memory labels, etc.)
 * @param hoursElapsed - Hours since session ended
 * @returns Score in [0, 1] range
 */
export function calculateRelevanceScore(
  session: SessionState,
  currentKeywords: string[],
  hoursElapsed: number,
): number {
  // Recency weight (0 at 7+ days)
  const recency = Math.max(0, 1 - hoursElapsed / 168);

  // Topic overlap (Jaccard-like)
  const sessionTopics = new Set(session.hot_topics.map((t) => t.toLowerCase()));
  const currentSet = new Set(currentKeywords.map((k) => k.toLowerCase()));
  const intersection = [...currentSet].filter((k) => sessionTopics.has(k)).length;
  const union = new Set([...currentSet, ...sessionTopics]).size;
  const topicOverlap = union > 0 ? intersection / union : 0;

  // Pending tasks weight
  const pendingWeight = Math.min(1.0, session.pending_tasks.length * 0.25);

  return recency * 0.4 + topicOverlap * 0.35 + pendingWeight * 0.25;
}
