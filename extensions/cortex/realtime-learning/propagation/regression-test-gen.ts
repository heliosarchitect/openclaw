/**
 * Real-Time Learning — Regression Test Generator
 * Cortex v2.6.0 (task-011)
 *
 * Creates regression test entries in brain.db and generates .test.ts stubs
 * for TRUST_DEM and PIPE_FAIL events.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FailureEvent, RealtimeLearningDB } from "../types.js";

export class RegressionTestGen {
  private db: RealtimeLearningDB;
  private repoRoot: string;
  private logger?: { debug?: (msg: string) => void; info?: (msg: string) => void };

  constructor(
    db: RealtimeLearningDB,
    repoRoot: string,
    logger?: { debug?: (msg: string) => void; info?: (msg: string) => void },
  ) {
    this.db = db;
    this.repoRoot = repoRoot;
    this.logger = logger;
  }

  async generate(failure: FailureEvent): Promise<{ id: string; test_file?: string }> {
    const id = this.generateId();
    const description = `regression: ${failure.type} — ${failure.root_cause ?? "unknown"} (${failure.id.substring(0, 8)})`;

    // Insert into brain.db
    await this.db.run(
      `INSERT INTO regression_tests (id, failure_id, description, active)
       VALUES (?, ?, ?, 1)`,
      [id, failure.id, description],
    );

    // Generate test file stub
    const testDir = join(this.repoRoot, "realtime-learning", "__tests__", "regression");

    try {
      await mkdir(testDir, { recursive: true });
      const testFile = join(testDir, `${failure.id.substring(0, 8)}.test.ts`);
      const testContent = this.generateTestStub(failure, id);
      await writeFile(testFile, testContent, "utf8");

      // Update test_file in DB
      await this.db.run("UPDATE regression_tests SET test_file = ? WHERE id = ?", [testFile, id]);

      this.logger?.info?.(`[RegressionTestGen] Created regression test ${id} → ${testFile}`);
      return { id, test_file: testFile };
    } catch (err) {
      this.logger?.debug?.(`[RegressionTestGen] Test file generation failed: ${err}`);
      return { id };
    }
  }

  private generateTestStub(failure: FailureEvent, testId: string): string {
    const escapedDesc = (failure.failure_desc ?? "").replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const rootCause = failure.root_cause ?? "unknown";

    return `/**
 * Auto-generated regression test
 * Failure ID: ${failure.id}
 * Type: ${failure.type}
 * Root Cause: ${rootCause}
 * Generated: ${new Date().toISOString()}
 */

import { describe, it, expect } from "vitest";

describe("regression: ${failure.type} — ${rootCause}", () => {
  it("should not recur after propagation (failure ${failure.id.substring(0, 8)})", async () => {
    // Original failure context:
    // ${escapedDesc}
    //
    // Source: ${failure.source}
    // Context: ${JSON.stringify(failure.context).substring(0, 200)}
    
    // TODO: Reproduce the original failure condition
    // Assert that the patched SOP/hook/atom prevents recurrence
    
    // Placeholder — replace with actual reproduction logic
    expect(true).toBe(true);
  });
});
`;
  }

  private generateId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
