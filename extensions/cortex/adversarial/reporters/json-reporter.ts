/**
 * JSON Reporter — Writes adversarial test results to disk.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ASTRunResult } from "../types.js";

export async function writeJsonReport(result: ASTRunResult, outputDir: string): Promise<string> {
  const filename = `adversarial-results-${result.run_id}.json`;
  const path = join(outputDir, filename);
  await writeFile(path, JSON.stringify(result, null, 2));
  return path;
}

/** Write latest results as the canonical adversarial-results.json */
export async function writeLatestReport(result: ASTRunResult, outputDir: string): Promise<string> {
  const path = join(outputDir, "adversarial-results.json");
  await writeFile(path, JSON.stringify(result, null, 2));
  return path;
}
