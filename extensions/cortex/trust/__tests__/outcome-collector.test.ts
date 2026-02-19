/**
 * OutcomeCollector unit tests
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustGate } from "../gate.js";
import { runMigration } from "../migration.js";
import { OutcomeCollector, detectCorrectionSeverity } from "../outcome-collector.js";

describe("detectCorrectionSeverity", () => {
  it("detects significant corrections", () => {
    expect(detectCorrectionSeverity("That broke everything")).toBe("significant");
    expect(detectCorrectionSeverity("revert that immediately")).toBe("significant");
    expect(detectCorrectionSeverity("you crashed the server")).toBe("significant");
  });

  it("detects minor corrections", () => {
    expect(detectCorrectionSeverity("no, that's wrong")).toBe("minor");
    expect(detectCorrectionSeverity("undo that")).toBe("minor");
    expect(detectCorrectionSeverity("that's not right")).toBe("minor");
  });

  it("returns null for non-corrections", () => {
    expect(detectCorrectionSeverity("looks good")).toBeNull();
    expect(detectCorrectionSeverity("thanks")).toBeNull();
  });
});

describe("OutcomeCollector", () => {
  let db: Database.Database;
  let collector: OutcomeCollector;
  let gate: TrustGate;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigration(db);
    gate = new TrustGate(db);
    collector = new OutcomeCollector(db);
  });

  afterEach(() => {
    db.close();
  });

  it("resolves outcome and updates trust score", () => {
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    const scoreBefore = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'read_file'`)
      .get() as { current_score: number };

    const result = collector.resolveOutcome(
      decision.decision_id,
      "pass",
      "feedback_window_expired",
    );
    expect(result).toBeTruthy();
    expect(result!.newScore).toBeGreaterThanOrEqual(result!.oldScore);

    // Check decision_log updated
    const row = db
      .prepare(`SELECT outcome FROM decision_log WHERE decision_id = ?`)
      .get(decision.decision_id) as { outcome: string };
    expect(row.outcome).toBe("pass");

    // Check pending_outcomes removed
    const pending = db
      .prepare(`SELECT * FROM pending_outcomes WHERE decision_id = ?`)
      .get(decision.decision_id);
    expect(pending).toBeUndefined();
  });

  it("does not resolve already-resolved outcomes", () => {
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    collector.resolveOutcome(decision.decision_id, "pass", "feedback_window_expired");
    const result = collector.resolveOutcome(
      decision.decision_id,
      "corrected_minor",
      "correction_detected",
    );
    expect(result).toBeNull();
  });

  it("recordCorrection finds and resolves most recent pending", () => {
    gate.check("Write", { path: "/tmp/foo.ts" }, "test-session");
    // Set score high enough to pass
    db.prepare(`UPDATE trust_scores SET current_score = 0.90 WHERE category = 'write_file'`).run();
    const decision = gate.check("Write", { path: "/tmp/bar.ts" }, "test-session");

    const result = collector.recordCorrection("no, that's wrong", "write_file");
    expect(result.resolved).toBe(true);
    expect(result.severity).toBe("minor");
  });

  it("pendingCount returns correct count", () => {
    gate.check("Read", { path: "/tmp/a" }, "s1");
    gate.check("Read", { path: "/tmp/b" }, "s1");
    expect(collector.pendingCount()).toBe(2);
  });
});
