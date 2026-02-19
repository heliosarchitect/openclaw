/**
 * Memory Writer — stores the distilled abstraction as a new cortex memory.
 */
import { randomUUID } from "node:crypto";
import type { CortexBridge } from "../cortex-bridge.js";
import type { CompressedMemoryRecord, DistillationResult, MemoryCluster } from "./types.js";

export async function writeCompressedMemory(
  bridge: CortexBridge,
  cluster: MemoryCluster,
  distillation: DistillationResult,
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();

  // Get max importance from source memories
  const placeholders = cluster.member_ids.map(() => "?").join(",");
  const maxRow = await bridge.getSQL<{ max_imp: number }>(
    `SELECT MAX(importance) as max_imp FROM memories WHERE id IN (${placeholders})`,
    cluster.member_ids,
  );
  const importance = maxRow?.max_imp ?? 1.5;

  // Get date range of sources
  const rangeRow = await bridge.getSQL<{ min_ts: string; max_ts: string }>(
    `SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM memories WHERE id IN (${placeholders})`,
    cluster.member_ids,
  );

  // Top-2 categories by frequency + always include 'compressed'
  const catRows = await bridge.allSQL<{ categories: string }>(
    `SELECT categories FROM memories WHERE id IN (${placeholders})`,
    cluster.member_ids,
  );
  const catCounts = new Map<string, number>();
  for (const row of catRows) {
    let cats: string[];
    try {
      cats = JSON.parse(row.categories);
    } catch {
      cats = row.categories ? [row.categories] : [];
    }
    for (const c of cats) {
      catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
    }
  }
  const topCats = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cat]) => cat);
  if (!topCats.includes("compressed")) topCats.push("compressed");
  const categories = JSON.stringify(topCats);

  const compressedFrom = JSON.stringify(cluster.member_ids);
  const metadata = JSON.stringify({
    compression_ratio: distillation.compression_ratio,
    cluster_size: cluster.member_count,
    distilled_at: now,
    source_date_range: [rangeRow?.min_ts ?? now, rangeRow?.max_ts ?? now],
  });

  await bridge.runSQL(
    `INSERT INTO memories (id, content, categories, importance, timestamp, access_count, compressed_from, source)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'abstraction-engine')`,
    [id, distillation.abstraction, categories, importance, now, compressedFrom],
  );

  // Also store in embeddings daemon for semantic search
  try {
    await fetch("http://localhost:8030/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        content: distillation.abstraction,
        category: topCats[0] ?? "compressed",
        importance,
        source: "abstraction-engine",
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal — memory is in DB, embedding will sync later
  }

  return id;
}
