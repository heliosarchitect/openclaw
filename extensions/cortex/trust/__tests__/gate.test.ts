/**
 * TrustGate unit tests
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustGate } from "../gate.js";
import { runMigration } from "../migration.js";

describe("TrustGate", () => {
  let db: Database.Database;
  let gate: TrustGate;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigration(db);
    gate = new TrustGate(db);
  });

  afterEach(() => {
    db.close();
  });

  it("passes tier 1 read_file (initial score 0.75 >= threshold 0.50)", () => {
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    expect(decision.result).toBe("pass");
    expect(decision.tier).toBe(1);
    expect(decision.category).toBe("read_file");
  });

  it("pauses tier 2 when score below threshold", () => {
    // Set write_file score below threshold (0.70)
    db.prepare(`UPDATE trust_scores SET current_score = 0.50 WHERE category = 'write_file'`).run();
    const decision = gate.check("Write", { path: "/tmp/foo.ts" }, "test-session");
    expect(decision.result).toBe("pause");
    expect(decision.tier).toBe(2);
  });

  it("blocks when score below floor", () => {
    db.prepare(`UPDATE trust_scores SET current_score = 0.15 WHERE category = 'read_file'`).run();
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    expect(decision.result).toBe("block");
  });

  it("tier 4 always pauses (financial hardcap)", () => {
    const decision = gate.check("exec", { command: "augur-trading trade BTC" }, "test-session");
    expect(decision.result).toBe("pause");
    expect(decision.reason).toBe("financial_hardcap");
  });

  it("grant override bypasses threshold", () => {
    db.prepare(`UPDATE trust_scores SET current_score = 0.10 WHERE category = 'write_file'`).run();
    db.prepare(
      `INSERT INTO trust_overrides (override_id, category, override_type, reason, active)
       VALUES ('test-1', 'write_file', 'granted', 'test', 1)`,
    ).run();
    const decision = gate.check("Write", { path: "/tmp/foo.ts" }, "test-session");
    expect(decision.result).toBe("pass");
    expect(decision.override_active).toBe(true);
  });

  it("revoke override blocks regardless of score", () => {
    db.prepare(`UPDATE trust_scores SET current_score = 0.99 WHERE category = 'write_file'`).run();
    db.prepare(
      `INSERT INTO trust_overrides (override_id, category, override_type, reason, active)
       VALUES ('test-1', 'write_file', 'revoked', 'test', 1)`,
    ).run();
    const decision = gate.check("Write", { path: "/tmp/foo.ts" }, "test-session");
    expect(decision.result).toBe("block");
    expect(decision.override_active).toBe(true);
  });

  it("logs decision to decision_log", () => {
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    const row = db
      .prepare(`SELECT * FROM decision_log WHERE decision_id = ?`)
      .get(decision.decision_id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.tool_name).toBe("Read");
    expect(row.gate_decision).toBe("pass");
    expect(row.outcome).toBe("pending");
  });

  it("creates pending_outcome for PASS decisions", () => {
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    const pending = db
      .prepare(`SELECT * FROM pending_outcomes WHERE decision_id = ?`)
      .get(decision.decision_id);
    expect(pending).toBeTruthy();
  });

  it("does NOT create pending_outcome for PAUSE/BLOCK decisions", () => {
    db.prepare(`UPDATE trust_scores SET current_score = 0.50 WHERE category = 'write_file'`).run();
    const decision = gate.check("Write", { path: "/tmp/foo.ts" }, "test-session");
    expect(decision.result).toBe("pause");
    const pending = db
      .prepare(`SELECT * FROM pending_outcomes WHERE decision_id = ?`)
      .get(decision.decision_id);
    expect(pending).toBeUndefined();
  });
});
