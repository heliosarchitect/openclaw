/**
 * MilestoneDetector tests
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigration } from "../migration.js";
import { MilestoneDetector } from "../milestone-detector.js";

describe("MilestoneDetector", () => {
  let db: Database.Database;
  let detector: MilestoneDetector;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigration(db);
    detector = new MilestoneDetector(db);
  });

  afterEach(() => {
    db.close();
  });

  it("detects first_auto_approve when crossing threshold upward", () => {
    const milestones = detector.check("write_file", 2, 0.69, 0.71);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].milestone_type).toBe("first_auto_approve");
    expect(milestones[0].category).toBe("write_file");
  });

  it("detects tier_promotion on subsequent threshold crossings", () => {
    // First crossing
    detector.check("write_file", 2, 0.69, 0.71);
    // Second crossing (after a demotion)
    const milestones = detector.check("write_file", 2, 0.69, 0.72);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].milestone_type).toBe("tier_promotion");
  });

  it("detects tier_demotion when crossing threshold downward", () => {
    const milestones = detector.check("write_file", 2, 0.71, 0.69);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].milestone_type).toBe("tier_demotion");
  });

  it("detects blocked when crossing floor downward", () => {
    const milestones = detector.check("write_file", 2, 0.41, 0.39);
    expect(milestones).toHaveLength(1);
    expect(milestones[0].milestone_type).toBe("blocked");
  });

  it("can emit both demotion and blocked in one check", () => {
    // Score drops from above threshold to below floor in one update
    const milestones = detector.check("write_file", 2, 0.71, 0.39);
    expect(milestones).toHaveLength(2);
    const types = milestones.map((m) => m.milestone_type);
    expect(types).toContain("tier_demotion");
    expect(types).toContain("blocked");
  });

  it("emits nothing when score changes within same zone", () => {
    const milestones = detector.check("write_file", 2, 0.75, 0.77);
    expect(milestones).toHaveLength(0);
  });

  it("persists milestones to database", () => {
    detector.check("write_file", 2, 0.69, 0.71);
    const rows = db.prepare(`SELECT * FROM trust_milestones`).all();
    expect(rows).toHaveLength(1);
  });

  it("recordOverrideMilestone stores override milestones", () => {
    const m = detector.recordOverrideMilestone(
      "write_file",
      "override_granted",
      0.65,
      "test reason",
    );
    expect(m.milestone_type).toBe("override_granted");
    const row = db
      .prepare(`SELECT * FROM trust_milestones WHERE milestone_id = ?`)
      .get(m.milestone_id);
    expect(row).toBeTruthy();
  });
});
