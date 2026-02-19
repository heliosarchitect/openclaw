/**
 * Real-Time Learning — Regression Test Generator Tests
 * Task-011: test stage
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FailureEvent, RealtimeLearningDB } from "../types.js";
import { RegressionTestGen } from "../propagation/regression-test-gen.js";

function makeFailure(overrides: Partial<FailureEvent> = {}): FailureEvent {
  return {
    id: "fail-reg-001",
    detected_at: new Date().toISOString(),
    type: "TRUST_DEM",
    tier: 3,
    source: "task-010-trust-engine",
    context: { milestone: "corrected_significant" },
    failure_desc: "Overwrote config without approval",
    root_cause: "trust_boundary_crossed",
    propagation_status: "pending",
    recurrence_count: 0,
    ...overrides,
  };
}

describe("RegressionTestGen", () => {
  let tmpDir: string;
  let db: RealtimeLearningDB;
  let gen: RegressionTestGen;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "regtest-gen-"));
    db = {
      run: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    };
    gen = new RegressionTestGen(db, tmpDir, { info: vi.fn(), debug: vi.fn() });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inserts regression test entry into DB", async () => {
    const result = await gen.generate(makeFailure());
    expect(result.id).toBeTruthy();
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO regression_tests"),
      expect.arrayContaining([
        expect.any(String),
        "fail-reg-001",
        expect.stringContaining("TRUST_DEM"),
      ]),
    );
  });

  it("creates test file stub on disk", async () => {
    const result = await gen.generate(makeFailure());
    expect(result.test_file).toBeTruthy();
    expect(existsSync(result.test_file!)).toBe(true);

    const content = readFileSync(result.test_file!, "utf8");
    expect(content).toContain("Auto-generated regression test");
    expect(content).toContain("fail-reg-001");
    expect(content).toContain("TRUST_DEM");
    expect(content).toContain("trust_boundary_crossed");
    expect(content).toContain("vitest");
  });

  it("updates test_file path in DB after file creation", async () => {
    await gen.generate(makeFailure());
    // Second call to db.run should be the UPDATE
    const calls = (db.run as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = calls.find((c: unknown[]) =>
      (c[0] as string).includes("UPDATE regression_tests"),
    );
    expect(updateCall).toBeTruthy();
  });

  it("handles file creation failure gracefully", async () => {
    // Use a read-only path that will fail on mkdir
    const badGen = new RegressionTestGen(db, "/dev/null/impossible", {
      info: vi.fn(),
      debug: vi.fn(),
    });
    const result = await badGen.generate(makeFailure());
    // Should still return an id (DB insert succeeds), but no test_file
    expect(result.id).toBeTruthy();
    expect(result.test_file).toBeUndefined();
  });

  it("escapes special characters in failure descriptions", async () => {
    const failure = makeFailure({
      failure_desc: "Template literal: `${value}` and backtick `test`",
    });
    const result = await gen.generate(failure);
    const content = readFileSync(result.test_file!, "utf8");
    // $ signs should be escaped so template literals aren't evaluated
    expect(content).toContain("\\$");
    // Backticks should be escaped
    expect(content).toContain("\\`");
  });

  it("generates unique IDs for each test", async () => {
    const r1 = await gen.generate(makeFailure({ id: "fail-a" }));
    const r2 = await gen.generate(makeFailure({ id: "fail-b" }));
    expect(r1.id).not.toBe(r2.id);
  });
});
