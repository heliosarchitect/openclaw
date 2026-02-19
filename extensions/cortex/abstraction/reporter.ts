/**
 * Reporter — generates compression run reports as JSON artifacts.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CompressionRunReport } from "./types.js";

const REPORTS_DIR = join(homedir(), "Projects/helios/extensions/cortex/reports");

export async function writeReport(report: CompressionRunReport): Promise<string> {
  if (!existsSync(REPORTS_DIR)) {
    await mkdir(REPORTS_DIR, { recursive: true });
  }
  const path = join(REPORTS_DIR, `compression-${report.run_id}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function formatSynapseSummary(report: CompressionRunReport): string {
  const lines = [
    `📦 **Knowledge Compression Run Complete** (${report.verdict})`,
    ``,
    `• Scanned: ${report.memories_scanned} memories`,
    `• Clusters found: ${report.clusters_found} (${report.clusters_skipped} skipped)`,
    `• Compressed: ${report.clusters_compressed} clusters → ${report.abstractions_created} abstractions`,
    `• Archived: ${report.memories_archived} source memories`,
    `• Atoms: ${report.atoms_created} created, ${report.atoms_enriched} enriched`,
    `• Token reduction: ${report.tokens_before} → ${report.tokens_after} (${report.token_reduction_pct.toFixed(1)}% saved)`,
    `• Avg compression ratio: ${report.avg_compression_ratio.toFixed(1)}x`,
    `• Duration: ${(report.duration_ms / 1000).toFixed(1)}s`,
  ];
  if (report.errors.length > 0) {
    lines.push(``, `⚠️ Errors: ${report.errors.length}`);
    for (const e of report.errors.slice(0, 5)) {
      lines.push(`  - [${e.stage}] ${e.message}`);
    }
  }
  return lines.join("\n");
}
