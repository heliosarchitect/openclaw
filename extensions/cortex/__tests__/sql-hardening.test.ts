import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * SQL Hardening Tests — Bridge Base64 Encoding (task-017-bridge-sql-hardening)
 *
 * Validates FINDING-001 fix (commit 3f25091b4): base64-encoded SQL parameter
 * passing eliminates injection vectors in runSQL/getSQL/allSQL.
 *
 * These tests spawn real Python subprocesses against a temp SQLite database.
 * They are slower than pure-TS unit tests (~50-200ms per call).
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { CortexBridge } from "../cortex-bridge.js";

// ─── Test Infrastructure ───

let bridge: CortexBridge;
let tmpDir: string;
const originalEnv = process.env.CORTEX_DATA_DIR;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cortex-sql-hardening-"));
  bridge = new CortexBridge({ memoryDir: tmpDir });

  // Create scratch table for tests
  await bridge.runSQL("CREATE TABLE IF NOT EXISTS test_harness (id TEXT PRIMARY KEY, val TEXT)");
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  if (originalEnv) process.env.CORTEX_DATA_DIR = originalEnv;
});

// ─── Script Integrity (AC-011, AC-012, AC-013, AC-014) ───

describe("Script Integrity", () => {
  it("runSQL script does not embed raw SQL text (AC-011/012)", async () => {
    const spy = vi.spyOn(bridge as any, "runPython").mockResolvedValue(null);
    const sql = "SELECT id FROM test_harness WHERE id = 'test'";
    await bridge.runSQL(sql);

    const script = spy.mock.calls[0][0] as string;
    expect(script).not.toContain(sql);
    expect(script).toContain("base64");
    expect(script).toContain("base64.b64decode");
    spy.mockRestore();
  });

  it("getSQL script does not embed raw SQL text (AC-011/012)", async () => {
    const spy = vi.spyOn(bridge as any, "runPython").mockResolvedValue(null);
    const sql = "SELECT id FROM test_harness WHERE val = 'something'";
    await bridge.getSQL(sql);

    const script = spy.mock.calls[0][0] as string;
    expect(script).not.toContain(sql);
    expect(script).toContain("base64.b64decode");
    spy.mockRestore();
  });

  it("allSQL script does not embed raw SQL text (AC-011/012)", async () => {
    const spy = vi.spyOn(bridge as any, "runPython").mockResolvedValue([]);
    const sql = "SELECT id FROM test_harness WHERE val LIKE '%test%'";
    await bridge.allSQL(sql);

    const script = spy.mock.calls[0][0] as string;
    expect(script).not.toContain(sql);
    expect(script).toContain("base64.b64decode");
    spy.mockRestore();
  });

  it("no escape-based SQL handling in source (AC-011 static check)", async () => {
    const srcPath = join(import.meta.dirname!, "..", "cortex-bridge.ts");
    const src = readFileSync(srcPath, "utf8");

    // Extract the runSQL/getSQL/allSQL region (~lines 1126-1180)
    const methodRegion = src.slice(
      src.indexOf("async runSQL("),
      src.indexOf("async allSQL<T") + src.slice(src.indexOf("async allSQL<T")).indexOf("\n  }") + 4,
    );

    // Must not contain old escape pattern
    expect(methodRegion).not.toMatch(/\.replace\(\s*\/'/);
    expect(methodRegion).not.toMatch(/\.replace\(\s*\/\\n/);
    // Must contain base64 pattern
    expect(methodRegion).toContain('Buffer.from(sql).toString("base64")');
    expect(methodRegion).toContain("base64.b64decode");
  });
});

// ─── runSQL Happy Path (AC-001, AC-002) ───

describe("runSQL — Happy Path", () => {
  it("executes DDL (CREATE TABLE) without error (AC-001)", async () => {
    await expect(
      bridge.runSQL("CREATE TABLE IF NOT EXISTS test_ddl (id TEXT PRIMARY KEY)"),
    ).resolves.not.toThrow();
  });

  it("executes DML (INSERT with params) (AC-002)", async () => {
    await expect(
      bridge.runSQL("INSERT INTO test_harness VALUES (?, ?)", ["happy-path-1", "value-1"]),
    ).resolves.not.toThrow();
  });
});

// ─── runSQL Injection Resistance (AC-006 through AC-010) ───

describe("runSQL — Injection Resistance", () => {
  it("SQL with single quote does not break Python (AC-006)", async () => {
    await expect(
      bridge.runSQL("INSERT INTO test_harness VALUES (?, ?)", ["quote-test", "it's a test"]),
    ).resolves.not.toThrow();
  });

  it("backslash-quote bypass does not break Python (FINDING-001 / AC-007)", async () => {
    // This is the exact bypass vector from the security review
    await expect(
      bridge.runSQL("INSERT INTO test_harness VALUES (?, ?)", [
        "bslash-quote",
        "path\\'with quotes",
      ]),
    ).resolves.not.toThrow();
  });

  it("SQL with newline executes correctly (AC-008)", async () => {
    const multiLineSql = `INSERT INTO test_harness
      VALUES (?, ?)`;
    await expect(
      bridge.runSQL(multiLineSql, ["newline-test", "multi-line"]),
    ).resolves.not.toThrow();
  });

  it("params containing SQL injection payload (AC-010)", async () => {
    const injectionPayload = "'; DROP TABLE test_harness;--";
    await expect(
      bridge.runSQL("INSERT INTO test_harness VALUES (?, ?)", ["injection-test", injectionPayload]),
    ).resolves.not.toThrow();

    // Verify table still exists
    const rows = await bridge.allSQL("SELECT * FROM test_harness");
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ─── getSQL — Happy Path + Injection Resistance (AC-003, AC-009) ───

describe("getSQL — Happy Path + Injection Resistance", () => {
  it("returns matching row (AC-003)", async () => {
    await bridge.runSQL("INSERT OR REPLACE INTO test_harness VALUES (?, ?)", [
      "get-test-1",
      "found-me",
    ]);
    const row = await bridge.getSQL<{ id: string; val: string }>(
      "SELECT * FROM test_harness WHERE id = ?",
      ["get-test-1"],
    );
    expect(row).not.toBeNull();
    expect(row!.id).toBe("get-test-1");
    expect(row!.val).toBe("found-me");
  });

  it("returns null for no-match (AC-003)", async () => {
    const row = await bridge.getSQL("SELECT * FROM test_harness WHERE id = ?", ["nonexistent-id"]);
    expect(row).toBeNull();
  });

  it("params with backslash return correct result (AC-009)", async () => {
    await bridge.runSQL("INSERT OR REPLACE INTO test_harness VALUES (?, ?)", [
      "path\\to\\file",
      "backslash-val",
    ]);
    const row = await bridge.getSQL<{ id: string; val: string }>(
      "SELECT * FROM test_harness WHERE id = ?",
      ["path\\to\\file"],
    );
    expect(row).not.toBeNull();
    expect(row!.val).toBe("backslash-val");
  });

  it("params with injection payload treated as literal (AC-009/010)", async () => {
    const result = await bridge.getSQL("SELECT * FROM test_harness WHERE id = ?", [
      "'; DROP TABLE test_harness;--",
    ]);
    expect(result).toBeNull();

    // Table must still exist
    const rows = await bridge.allSQL("SELECT * FROM test_harness");
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ─── allSQL — Happy Path + Injection Resistance (AC-004) ───

describe("allSQL — Happy Path + Injection Resistance", () => {
  it("returns all matching rows (AC-004)", async () => {
    await bridge.runSQL("INSERT OR REPLACE INTO test_harness VALUES (?, ?)", ["all-1", "group-a"]);
    await bridge.runSQL("INSERT OR REPLACE INTO test_harness VALUES (?, ?)", ["all-2", "group-a"]);
    const rows = await bridge.allSQL<{ id: string; val: string }>(
      "SELECT * FROM test_harness WHERE val = ?",
      ["group-a"],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("returns [] for no-match (AC-004)", async () => {
    const rows = await bridge.allSQL("SELECT * FROM test_harness WHERE val = ?", [
      "absolutely-nothing-matches",
    ]);
    expect(rows).toEqual([]);
  });

  it("params with injection payload treated as literal (AC-010)", async () => {
    const rows = await bridge.allSQL("SELECT * FROM test_harness WHERE id = ?", [
      "'; DROP TABLE test_harness;--",
    ]);
    expect(rows).toEqual([]);

    // Table survives
    const check = await bridge.allSQL("SELECT * FROM test_harness LIMIT 1");
    expect(Array.isArray(check)).toBe(true);
  });
});

// ─── Adversarial / Edge Cases ───

describe("Adversarial / Edge Cases", () => {
  it("multi-statement SQL does not execute second statement", async () => {
    await bridge.runSQL("INSERT OR REPLACE INTO test_harness VALUES (?, ?)", [
      "keep-me",
      "survivor",
    ]);

    // SQLite's execute() should reject or ignore the DROP
    try {
      await bridge.runSQL("SELECT 1; DROP TABLE test_harness", []);
    } catch {
      // Expected: SQLite rejects multi-statement
    }

    // Table and row must still exist
    const row = await bridge.getSQL<{ id: string }>("SELECT * FROM test_harness WHERE id = ?", [
      "keep-me",
    ]);
    expect(row).not.toBeNull();
  }, 10_000);

  it("4KB SQL string completes within 5 seconds", async () => {
    const longComment = "-- " + "x".repeat(4000);
    const sql = `${longComment}\nSELECT 1 as n FROM test_harness LIMIT 1`;

    const start = Date.now();
    await bridge.allSQL(sql, []);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it("Unicode params inserted verbatim", async () => {
    const unicodeVal = "emoji 🔒 and 'quote' and ñ and 日本語";
    await bridge.runSQL("INSERT OR REPLACE INTO test_harness VALUES (?, ?)", [
      "unicode-test",
      unicodeVal,
    ]);
    const row = await bridge.getSQL<{ id: string; val: string }>(
      "SELECT * FROM test_harness WHERE id = ?",
      ["unicode-test"],
    );
    expect(row).not.toBeNull();
    expect(row!.val).toBe(unicodeVal);
  });
});
