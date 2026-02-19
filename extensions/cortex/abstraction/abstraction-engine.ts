/**
 * Abstraction Engine — main orchestrator for knowledge compression.
 *
 * Runs as a nightly cron job or manually via ~/bin/run-compression.
 * Clusters similar memories → distills → writes compressed memory →
 * archives sources → enriches atom graph → reports.
 *
 * Phase 5.4 of IMPROVEMENT_PLAN
 */
import { randomUUID } from "node:crypto";
import type { CompressionError, CompressionRunReport } from "./types.js";
import { CortexBridge, estimateTokens } from "../cortex-bridge.js";
import { archiveSourceMemories } from "./archiver.js";
import { enrichAtoms } from "./atom-enricher.js";
import { findClusters, clusterFingerprint } from "./cluster-finder.js";
import { distillCluster } from "./distiller.js";
import { writeCompressedMemory } from "./memory-writer.js";
import { runMigration008 } from "./migration-008.js";
import { writeReport, formatSynapseSummary } from "./reporter.js";

const MAX_CLUSTERS_PER_MINUTE = 10;
const RATE_LIMIT_MS = 60_000 / MAX_CLUSTERS_PER_MINUTE; // 6s between clusters

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface AbstractionEngineOptions {
  dryRun?: boolean;
  maxClusters?: number;
  apiKey?: string;
  /** Injected atom_search — defaults to bridge method if available */
  atomSearch?: (field: string, query: string) => Promise<Array<{ id: string; similarity: number }>>;
  /** Injected atom_create — defaults to bridge method if available */
  atomCreate?: (atom: {
    subject: string;
    action: string;
    outcome: string;
    consequences: string;
  }) => Promise<{ id: string }>;
}

export async function runAbstractionEngine(
  options: AbstractionEngineOptions = {},
): Promise<CompressionRunReport> {
  const runId = randomUUID();
  const startedAt = new Date();
  const errors: CompressionError[] = [];
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";

  // Init bridge
  const bridge = new CortexBridge();

  // Run migration
  await runMigration008(bridge);

  // Measure baseline tokens
  const baselineRows = await bridge.allSQL<{ content: string }>(
    `SELECT content FROM stm WHERE importance > 0.5 AND archived_by IS NULL`,
  );
  const tokensBefore = baselineRows.reduce((sum, r) => sum + estimateTokens(r.content), 0);

  // Find clusters
  const clusters = await findClusters(bridge);
  const maxClusters = options.maxClusters ?? clusters.length;
  const toProcess = clusters.slice(0, maxClusters);

  let clustersCompressed = 0;
  let clustersSkipped = 0;
  let memoriesArchived = 0;
  let abstractionsCreated = 0;
  let atomsCreated = 0;
  let atomsEnriched = 0;
  let totalRatio = 0;
  let maxRatio = 0;

  for (const cluster of toProcess) {
    try {
      // Distill
      const distillation = await distillCluster(bridge, cluster, { apiKey });
      if (!distillation) {
        clustersSkipped++;
        await bridge.runSQL(
          `INSERT INTO compression_log (id, cluster_fingerprint, status, reason, member_count, created_at)
           VALUES (?, ?, 'skipped', 'compression_ratio_too_low', ?, datetime('now'))`,
          [randomUUID(), cluster.fingerprint, cluster.member_count],
        );
        continue;
      }

      if (options.dryRun) {
        console.log(
          `[DRY RUN] Would compress ${cluster.member_count} memories: ${distillation.abstraction.slice(0, 100)}...`,
        );
        clustersCompressed++;
        continue;
      }

      // F-002 fix: wrap write+archive+log in a single SQLite transaction
      await bridge.runSQL(`BEGIN TRANSACTION`);
      try {
        // Write compressed memory
        const compressedId = await writeCompressedMemory(bridge, cluster, distillation);
        abstractionsCreated++;

        // Archive source memories (inline instead of calling archiver to stay in transaction)
        for (const mid of cluster.member_ids) {
          await bridge.runSQL(`UPDATE stm SET importance = 0.5, archived_by = ? WHERE id = ?`, [
            cluster.cluster_id,
            mid,
          ]);
        }
        memoriesArchived += cluster.member_ids.length;

        // Log compression
        await bridge.runSQL(
          `INSERT INTO compression_log (id, cluster_fingerprint, compressed_memory_id, status, member_count, compression_ratio, created_at)
           VALUES (?, ?, ?, 'compressed', ?, ?, datetime('now'))`,
          [
            randomUUID(),
            cluster.fingerprint,
            compressedId,
            cluster.member_count,
            distillation.compression_ratio,
          ],
        );

        await bridge.runSQL(`COMMIT`);
      } catch (txErr) {
        try {
          await bridge.runSQL(`ROLLBACK`);
        } catch {
          /* best effort */
        }
        throw txErr;
      }

      // Atom enrichment (if causal)
      if (distillation.is_causal && apiKey) {
        try {
          const atomResult = await enrichAtoms(distillation.abstraction, {
            apiKey,
            atomSearch: options.atomSearch ?? (async () => []),
            atomCreate: options.atomCreate ?? (async () => ({ id: "mock" })),
          });
          if (atomResult.created) atomsCreated++;
          if (atomResult.enriched_existing) atomsEnriched++;
        } catch (err) {
          errors.push({
            cluster_id: cluster.cluster_id,
            stage: "enrich",
            message: String(err),
            timestamp: new Date().toISOString(),
          });
        }
      }

      clustersCompressed++;
      totalRatio += distillation.compression_ratio;
      maxRatio = Math.max(maxRatio, distillation.compression_ratio);

      // Rate limiting
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      errors.push({
        cluster_id: cluster.cluster_id,
        stage: "distill",
        message: String(err),
        timestamp: new Date().toISOString(),
      });
      clustersSkipped++;
    }
  }

  // Measure post-compression tokens
  const postRows = await bridge.allSQL<{ content: string }>(
    `SELECT content FROM stm WHERE importance > 0.5 AND archived_by IS NULL`,
  );
  const tokensAfter = postRows.reduce((sum, r) => sum + estimateTokens(r.content), 0);

  const finishedAt = new Date();
  const report: CompressionRunReport = {
    run_id: runId,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),

    memories_scanned: baselineRows.length,
    clusters_found: clusters.length,
    clusters_skipped: clustersSkipped,
    clusters_compressed: clustersCompressed,

    memories_archived: memoriesArchived,
    abstractions_created: abstractionsCreated,
    atoms_created: atomsCreated,
    atoms_enriched: atomsEnriched,

    tokens_before: tokensBefore,
    tokens_after: tokensAfter,
    token_reduction_pct: tokensBefore > 0 ? ((tokensBefore - tokensAfter) / tokensBefore) * 100 : 0,

    avg_compression_ratio: clustersCompressed > 0 ? totalRatio / clustersCompressed : 0,
    max_compression_ratio: maxRatio,

    errors,
    verdict: errors.length === 0 ? "PASS" : clustersCompressed > 0 ? "PARTIAL" : "FAIL",
  };

  // Write report
  const reportPath = await writeReport(report);
  console.log(`Compression report: ${reportPath}`);
  console.log(formatSynapseSummary(report));

  return report;
}

// CLI entry point
if (process.argv[1]?.includes("abstraction-engine")) {
  runAbstractionEngine({
    dryRun: process.argv.includes("--dry-run"),
  })
    .then((report) => {
      process.exit(report.verdict === "FAIL" ? 1 : 0);
    })
    .catch((err) => {
      console.error("Abstraction engine failed:", err);
      process.exit(1);
    });
}
