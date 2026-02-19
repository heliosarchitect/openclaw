/**
 * Migration 010 — Earned Autonomy schema tests
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigration } from "../migration.js";
import { KNOWN_CATEGORIES } from "../types.js";

describe("Migration 010", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all 6 tables", () => {
    runMigration(db);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r: any) => r.name);
    expect(tables).toContain("decision_log");
    expect(tables).toContain("trust_scores");
    expect(tables).toContain("trust_overrides");
    expect(tables).toContain("trust_milestones");
    expect(tables).toContain("pending_outcomes");
    expect(tables).toContain("pending_confirmations");
  });

  it("bootstraps trust_scores for all known categories", () => {
    runMigration(db);
    const rows = db
      .prepare(`SELECT category, risk_tier, current_score FROM trust_scores`)
      .all() as any[];
    expect(rows.length).toBe(KNOWN_CATEGORIES.length);
    for (const { category, tier } of KNOWN_CATEGORIES) {
      const row = rows.find((r: any) => r.category === category);
      expect(row, `Missing category: ${category}`).toBeTruthy();
      expect(row.risk_tier).toBe(tier);
    }
  });

  it("sets correct initial scores per tier", () => {
    runMigration(db);
    const t1 = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'read_file'`)
      .get() as any;
    const t2 = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'write_file'`)
      .get() as any;
    const t3 = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'service_restart'`)
      .get() as any;
    const t4 = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'financial_augur'`)
      .get() as any;
    expect(t1.current_score).toBe(0.75);
    expect(t2.current_score).toBe(0.65);
    expect(t3.current_score).toBe(0.55);
    expect(t4.current_score).toBe(0.0);
  });

  it("is idempotent (running twice does not duplicate)", () => {
    runMigration(db);
    runMigration(db);
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM trust_scores`).get() as any;
    expect(count.cnt).toBe(KNOWN_CATEGORIES.length);
  });

  it("creates expected indexes", () => {
    runMigration(db);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
      .all()
      .map((r: any) => r.name);
    expect(indexes).toContain("idx_dl_category");
    expect(indexes).toContain("idx_dl_timestamp");
    expect(indexes).toContain("idx_dl_outcome");
    expect(indexes).toContain("idx_dl_pending");
    expect(indexes).toContain("idx_to_category");
  });

  it("decision_log enforces risk_tier constraint", () => {
    runMigration(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO decision_log (decision_id, session_id, tool_name, tool_params_hash, tool_params_summary, risk_tier, category, gate_decision, trust_score_at_decision)
           VALUES ('x', 's', 't', 'h', 'sum', 5, 'cat', 'pass', 0.5)`,
        )
        .run(),
    ).toThrow();
  });

  it("decision_log enforces gate_decision constraint", () => {
    runMigration(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO decision_log (decision_id, session_id, tool_name, tool_params_hash, tool_params_summary, risk_tier, category, gate_decision, trust_score_at_decision)
           VALUES ('x', 's', 't', 'h', 'sum', 1, 'cat', 'invalid', 0.5)`,
        )
        .run(),
    ).toThrow();
  });

  it("trust_scores enforces score range [0, 1]", () => {
    runMigration(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO trust_scores (score_id, category, risk_tier, current_score, ewma_alpha, initial_score)
           VALUES ('x', 'test_oob', 1, 1.5, 0.1, 0.75)`,
        )
        .run(),
    ).toThrow();
  });
});
