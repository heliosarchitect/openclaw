/**
 * TrustReporter tests
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigration } from "../migration.js";
import { TrustReporter } from "../reporter.js";
import { KNOWN_CATEGORIES } from "../types.js";

describe("TrustReporter", () => {
  let db: Database.Database;
  let reporter: TrustReporter;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigration(db);
    reporter = new TrustReporter(db);
  });

  afterEach(() => {
    db.close();
  });

  it("generateReport produces output containing all known categories", () => {
    const report = reporter.generateReport();
    for (const { category, tier } of KNOWN_CATEGORIES) {
      expect(report).toContain(category);
    }
  });

  it("generateReport contains tier headers", () => {
    const report = reporter.generateReport();
    expect(report).toContain("TIER 1 — READ-ONLY");
    expect(report).toContain("TIER 2 — NON-DESTRUCTIVE");
    expect(report).toContain("TIER 3 — INFRASTRUCTURE");
    expect(report).toContain("TIER 4 — FINANCIAL");
  });

  it("generateReport shows correct status for default scores", () => {
    const report = reporter.generateReport();
    // Tier 1 default 0.75 >= threshold 0.50 → auto-approve
    expect(report).toMatch(/read_file.*auto-approve/);
    // Tier 2 default 0.65 < threshold 0.70 → pause
    expect(report).toMatch(/write_file.*pause/);
    // Tier 3 default 0.55 < floor 0.60 → blocked
    expect(report).toMatch(/service_restart.*blocked/);
    // Tier 4 → hardcap
    expect(report).toMatch(/financial_augur.*hardcap/);
  });

  it("generateReport shows overrides when active", () => {
    db.prepare(
      `INSERT INTO trust_overrides (override_id, category, override_type, reason, active)
       VALUES ('t1', 'write_file', 'granted', 'batch migration', 1)`,
    ).run();
    const report = reporter.generateReport();
    expect(report).toContain("GRANTED write_file");
    expect(report).toContain("batch migration");
  });

  it("generateReport shows [none] when no overrides", () => {
    const report = reporter.generateReport();
    expect(report).toContain("[none]");
  });

  it("generateWeeklySummary returns valid summary text", () => {
    const summary = reporter.generateWeeklySummary();
    expect(summary).toContain("WEEKLY TRUST SUMMARY");
    expect(summary).toContain("PROMOTIONS:");
    expect(summary).toContain("DEMOTIONS:");
    expect(summary).toContain("BLOCKS:");
  });

  it("generateWeeklySummary includes recent milestones", () => {
    db.prepare(
      `INSERT INTO trust_milestones (milestone_id, category, milestone_type, old_score, new_score, trigger)
       VALUES ('m1', 'write_file', 'first_auto_approve', 0.69, 0.71, 'Score crossed threshold')`,
    ).run();
    const summary = reporter.generateWeeklySummary();
    expect(summary).toContain("write_file");
    expect(summary).toContain("first_auto_approve");
  });
});
