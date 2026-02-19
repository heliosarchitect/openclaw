/**
 * Cluster Finder — identifies groups of semantically similar memories for compression.
 *
 * Algorithm: single-linkage clustering with cosine similarity ≥ 0.82 threshold.
 * Memories with importance ≥ 2.5 are excluded (critical memories are never compressed).
 * Memories created within the last 24h are skipped (too fresh).
 * Clusters with fewer than 3 members are discarded.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { CortexBridge } from "../cortex-bridge.js";
import type { MemoryCandidate, MemoryCluster } from "./types.js";
import { estimateTokens } from "../cortex-bridge.js";

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Generate a deterministic fingerprint for a set of memory IDs */
export function clusterFingerprint(memberIds: string[]): string {
  const sorted = [...memberIds].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

/** Find the most common category across a set of memories */
function dominantCategory(candidates: MemoryCandidate[]): string {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    for (const cat of c.categories) {
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
  }
  let best = "general";
  let bestCount = 0;
  for (const [cat, count] of counts) {
    if (count > bestCount) {
      best = cat;
      bestCount = count;
    }
  }
  return best;
}

export interface ClusterFinderOptions {
  similarityThreshold?: number; // Default: 0.82
  minClusterSize?: number; // Default: 3
  maxImportance?: number; // Default: 2.5 (exclusive)
  minAgeHours?: number; // Default: 24
  batchSize?: number; // Default: 200
}

export async function findClusters(
  bridge: CortexBridge,
  options: ClusterFinderOptions = {},
): Promise<MemoryCluster[]> {
  const {
    similarityThreshold = 0.82,
    minClusterSize = 3,
    maxImportance = 2.5,
    minAgeHours = 24,
    batchSize = 200,
  } = options;

  // 1. Load candidate memories
  const cutoff = new Date(Date.now() - minAgeHours * 3600_000).toISOString();
  const rows = await bridge.allSQL<{
    id: string;
    content: string;
    categories: string;
    importance: number;
    timestamp: string;
    access_count: number;
  }>(
    `SELECT id, content, categories, importance, timestamp, access_count
     FROM memories
     WHERE importance < ?
       AND timestamp < ?
       AND archived_by IS NULL
       AND compressed_from IS NULL
     ORDER BY timestamp ASC`,
    [maxImportance, cutoff],
  );

  if (rows.length < minClusterSize) return [];

  const candidates: MemoryCandidate[] = rows.map((r) => ({
    id: r.id,
    content: r.content,
    categories: (() => {
      try {
        return JSON.parse(r.categories);
      } catch {
        return r.categories ? [r.categories] : ["general"];
      }
    })(),
    importance: r.importance,
    timestamp: r.timestamp,
    access_count: r.access_count,
  }));

  // 2. Load embeddings for these candidates from the daemon
  const embeddingsMap = new Map<string, number[]>();
  try {
    const resp = await fetch("http://localhost:8030/dump", {
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const dump = (await resp.json()) as {
        memories: Array<{ id: string; embedding?: number[] }>;
      };
      for (const m of dump.memories) {
        if (m.embedding) embeddingsMap.set(m.id, m.embedding);
      }
    }
  } catch {
    // If embeddings daemon is unavailable, we can't cluster
    return [];
  }

  // Filter to only candidates that have embeddings
  const withEmbeddings = candidates.filter((c) => embeddingsMap.has(c.id));
  if (withEmbeddings.length < minClusterSize) return [];

  // 3. Compute pairwise similarities and build adjacency (single-linkage)
  // Process in batches to avoid O(n²) memory blowup
  const adjacency = new Map<string, Set<string>>();
  for (const c of withEmbeddings) adjacency.set(c.id, new Set());

  for (let i = 0; i < withEmbeddings.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, withEmbeddings.length);
    for (let a = i; a < batchEnd; a++) {
      const embA = embeddingsMap.get(withEmbeddings[a].id)!;
      for (let b = a + 1; b < withEmbeddings.length; b++) {
        const embB = embeddingsMap.get(withEmbeddings[b].id)!;
        const sim = cosineSimilarity(embA, embB);
        if (sim >= similarityThreshold) {
          adjacency.get(withEmbeddings[a].id)!.add(withEmbeddings[b].id);
          adjacency.get(withEmbeddings[b].id)!.add(withEmbeddings[a].id);
        }
      }
    }
  }

  // 4. Connected components (single-linkage clusters)
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const c of withEmbeddings) {
    if (visited.has(c.id)) continue;
    const component: string[] = [];
    const stack = [c.id];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      component.push(node);
      for (const neighbor of adjacency.get(node) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    if (component.length >= minClusterSize) {
      clusters.push(component);
    }
  }

  // 5. Check idempotency — skip clusters already processed in last 7 days
  const recentFingerprints = new Set<string>();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const logRows = await bridge.allSQL<{ cluster_fingerprint: string }>(
    `SELECT cluster_fingerprint FROM compression_log WHERE created_at > ?`,
    [weekAgo],
  );
  for (const row of logRows) recentFingerprints.add(row.cluster_fingerprint);

  // 6. Build MemoryCluster objects
  const candidateMap = new Map(withEmbeddings.map((c) => [c.id, c]));
  const result: MemoryCluster[] = [];

  for (const memberIds of clusters) {
    const fp = clusterFingerprint(memberIds);
    if (recentFingerprints.has(fp)) continue;

    const members = memberIds.map((id) => candidateMap.get(id)!);

    // Compute average pairwise similarity
    let simSum = 0,
      simCount = 0;
    for (let a = 0; a < memberIds.length; a++) {
      for (let b = a + 1; b < memberIds.length; b++) {
        simSum += cosineSimilarity(
          embeddingsMap.get(memberIds[a])!,
          embeddingsMap.get(memberIds[b])!,
        );
        simCount++;
      }
    }

    result.push({
      cluster_id: randomUUID(),
      member_ids: memberIds,
      member_count: memberIds.length,
      avg_similarity: simCount > 0 ? simSum / simCount : 0,
      dominant_category: dominantCategory(members),
      total_tokens: members.reduce((sum, m) => sum + estimateTokens(m.content), 0),
      oldest_member_at: members.reduce(
        (oldest, m) => (m.timestamp < oldest ? m.timestamp : oldest),
        members[0].timestamp,
      ),
      fingerprint: fp,
    });
  }

  // Sort by size descending (biggest clusters = most compression opportunity)
  result.sort((a, b) => b.member_count - a.member_count);
  return result;
}
