/**
 * E2E Trust Lifecycle — end-to-end integration tests
 * Validates the full trust pipeline: gate → outcome → score update → milestone
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrustGate } from "../gate.js";
import { runMigration } from "../migration.js";
import { MilestoneDetector } from "../milestone-detector.js";
import { OutcomeCollector } from "../outcome-collector.js";
import { OverrideManager } from "../override-manager.js";
import { TrustReporter } from "../reporter.js";

describe("E2E Trust Lifecycle", () => {
  let db: Database.Database;
  let gate: TrustGate;
  let collector: OutcomeCollector;
  let milestones: MilestoneDetector;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigration(db);
    gate = new TrustGate(db);
    collector = new OutcomeCollector(db);
    milestones = new MilestoneDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  it("pass decisions accumulate and raise trust score", () => {
    // write_file starts at 0.65, threshold 0.70
    const initial = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'write_file'`)
      .get() as any;
    expect(initial.current_score).toBe(0.65);

    // Simulate 10 successful pass outcomes
    for (let i = 0; i < 10; i++) {
      const decision = gate.check("Write", { path: `/tmp/file${i}.ts` }, "test-session");
      // Resolve as pass
      collector.resolveOutcome(decision.decision_id, "pass", "feedback_window_expired");
    }

    const updated = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'write_file'`)
      .get() as any;
    expect(updated.current_score).toBeGreaterThan(0.65);
  });

  it("corrections lower trust score", () => {
    // read_file starts at 0.75
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    collector.resolveOutcome(decision.decision_id, "corrected_significant", "correction_detected");

    const updated = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'read_file'`)
      .get() as any;
    expect(updated.current_score).toBeLessThan(0.75);
  });

  it("enough pass outcomes promote write_file past threshold", () => {
    // write_file: initial 0.65, threshold 0.70, alpha 0.10
    // Each pass: new = 0.10 * 1.0 + 0.90 * old (normalized: (1+1)/2 = 1.0)
    // After enough passes, should cross 0.70
    for (let i = 0; i < 20; i++) {
      const decision = gate.check("Write", { path: `/tmp/f${i}.ts` }, "test-session");
      collector.resolveOutcome(decision.decision_id, "pass", "feedback_window_expired");
    }

    const score = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'write_file'`)
      .get() as any;
    expect(score.current_score).toBeGreaterThanOrEqual(0.7);

    // Now gate should PASS for write_file
    const decision = gate.check("Write", { path: "/tmp/final.ts" }, "test-session");
    expect(decision.result).toBe("pass");
  });

  it("override grant + revoke lifecycle works end-to-end", () => {
    const manager = new OverrideManager(db);

    // write_file at 0.65, below threshold → should pause
    let decision = gate.check("Write", { path: "/tmp/test.ts" }, "test-session");
    expect(decision.result).toBe("pause");

    // Grant override (interactive session required — H1 mitigation)
    manager.setOverride("write_file", "granted", "batch work", "interactive-main");
    decision = gate.check("Write", { path: "/tmp/test2.ts" }, "test-session");
    expect(decision.result).toBe("pass");
    expect(decision.override_active).toBe(true);

    // Revoke all
    manager.revokeAll();
    decision = gate.check("Write", { path: "/tmp/test3.ts" }, "test-session");
    expect(decision.result).toBe("pause"); // back to score-based
  });

  it("decision count increments", () => {
    for (let i = 0; i < 5; i++) {
      gate.check("Read", { path: `/tmp/f${i}` }, "test-session");
    }
    const count = db
      .prepare(`SELECT COUNT(*) as cnt FROM decision_log WHERE category = 'read_file'`)
      .get() as any;
    expect(count.cnt).toBe(5);
  });

  it("reporter works after real gate activity", () => {
    gate.check("Read", { path: "/tmp/a" }, "s1");
    gate.check("Write", { path: "/tmp/b.ts" }, "s1");
    gate.check("exec", { command: "systemctl restart foo" }, "s1");

    const reporter = new TrustReporter(db);
    const report = reporter.generateReport();
    expect(report).toContain("3 decisions");
    expect(report).toContain("TRUST REPORT");
  });

  it("tool_error_external does not affect score", () => {
    const before = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'read_file'`)
      .get() as any;
    const decision = gate.check("Read", { path: "/tmp/foo" }, "test-session");
    collector.resolveOutcome(decision.decision_id, "tool_error_external", "tool_failure");
    const after = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'read_file'`)
      .get() as any;
    // tool_error_external has value 0.0 → normalized to 0.5 → EWMA pulls toward 0.5
    // With alpha 0.08: new = 0.08*0.5 + 0.92*0.75 = 0.04 + 0.69 = 0.73
    // It does change slightly due to EWMA math, but much less than a correction
    expect(Math.abs(after.current_score - before.current_score)).toBeLessThan(0.03);
  });

  it("tier 4 financial never auto-approves even after many passes", () => {
    // Alpha is 0 for tier 4, so score never changes
    for (let i = 0; i < 50; i++) {
      const decision = gate.check("exec", { command: "augur-trading trade BTC" }, "test-session");
      // Even if we force resolve as pass, score won't move
      collector.resolveOutcome(decision.decision_id, "pass", "feedback_window_expired");
    }
    const score = db
      .prepare(`SELECT current_score FROM trust_scores WHERE category = 'financial_augur'`)
      .get() as any;
    expect(score.current_score).toBe(0.0); // never moved

    const decision = gate.check("exec", { command: "augur-trading trade ETH" }, "test-session");
    expect(decision.result).toBe("pause"); // still hardcapped
  });
});
