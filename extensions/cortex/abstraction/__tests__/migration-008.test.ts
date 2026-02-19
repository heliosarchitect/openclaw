/**
 * Unit tests for Migration 008
 */
import { describe, it, expect, vi } from "vitest";
import { runMigration008 } from "../migration-008.js";

describe("runMigration008", () => {
  it("creates compression_log table and indexes", async () => {
    const sqls: string[] = [];
    const bridge = {
      runSQL: vi.fn().mockImplementation(async (sql: string) => {
        sqls.push(sql.trim());
      }),
    } as any;

    await runMigration008(bridge);

    // Should have: CREATE TABLE, 2x CREATE INDEX, 2x ALTER TABLE
    expect(sqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS compression_log"))).toBe(true);
    expect(sqls.some((s) => s.includes("idx_compression_log_fingerprint"))).toBe(true);
    expect(sqls.some((s) => s.includes("idx_compression_log_created"))).toBe(true);
    expect(sqls.some((s) => s.includes("ADD COLUMN compressed_from"))).toBe(true);
    expect(sqls.some((s) => s.includes("ADD COLUMN archived_by"))).toBe(true);
  });

  it("is idempotent — handles existing columns gracefully", async () => {
    let alterCount = 0;
    const bridge = {
      runSQL: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("ALTER TABLE")) {
          alterCount++;
          throw new Error("duplicate column name");
        }
      }),
    } as any;

    // Should not throw despite ALTER TABLE errors
    await runMigration008(bridge);
    expect(alterCount).toBe(2); // Both ALTER TABLE attempts were made
  });
});
