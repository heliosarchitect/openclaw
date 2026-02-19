/**
 * OverrideManager tests
 * Updated: deploy stage security mitigations (H1 — session ID validation)
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigration } from "../migration.js";
import { OverrideManager } from "../override-manager.js";

const INTERACTIVE = "interactive-main"; // valid interactive session ID for tests

describe("OverrideManager", () => {
  let db: Database.Database;
  let manager: OverrideManager;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigration(db);
    manager = new OverrideManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it("grants an override", () => {
    const override = manager.setOverride("write_file", "granted", "batch migration", INTERACTIVE);
    expect(override.override_type).toBe("granted");
    expect(override.category).toBe("write_file");
    expect(override.active).toBe(true);
    expect(override.granted_by).toBe("matthew");
  });

  it("revokes an override", () => {
    const override = manager.setOverride("write_file", "revoked", "security concern", INTERACTIVE);
    expect(override.override_type).toBe("revoked");
    expect(override.active).toBe(true);
  });

  it("deactivates previous override when setting new one", () => {
    manager.setOverride("write_file", "granted", "first", INTERACTIVE);
    manager.setOverride("write_file", "granted", "second", INTERACTIVE);
    const active = manager.listActive();
    const writeOverrides = active.filter((o) => o.category === "write_file");
    expect(writeOverrides).toHaveLength(1);
    expect(writeOverrides[0].reason).toBe("second");
  });

  it("revokeAll deactivates all overrides", () => {
    manager.setOverride("write_file", "granted", "a", INTERACTIVE);
    manager.setOverride("cortex_write", "granted", "b", INTERACTIVE);
    const count = manager.revokeAll();
    expect(count).toBe(2);
    expect(manager.listActive()).toHaveLength(0);
  });

  it("listActive returns only active non-expired overrides", () => {
    manager.setOverride("write_file", "granted", "active one", INTERACTIVE);
    expect(manager.listActive()).toHaveLength(1);
  });

  it("supports expiry duration parsing", () => {
    const override = manager.setOverride("write_file", "granted", "temp", INTERACTIVE, "4h");
    expect(override.expires_at).toBeTruthy();
    const expiry = new Date(override.expires_at!).getTime();
    const now = Date.now();
    // Should be roughly 4 hours from now (within 10s tolerance)
    expect(expiry).toBeGreaterThan(now + 3.9 * 3600000);
    expect(expiry).toBeLessThan(now + 4.1 * 3600000);
  });

  it("rejects invalid duration format", () => {
    expect(() => manager.setOverride("write_file", "granted", "bad", INTERACTIVE, "4x")).toThrow(
      /Invalid duration format/,
    );
  });

  it("creates a milestone when granting override", () => {
    manager.setOverride("write_file", "granted", "test", INTERACTIVE);
    const milestones = db
      .prepare(`SELECT * FROM trust_milestones WHERE milestone_type = 'override_granted'`)
      .all();
    expect(milestones).toHaveLength(1);
  });

  it("creates a milestone when revoking override", () => {
    manager.setOverride("write_file", "revoked", "test", INTERACTIVE);
    const milestones = db
      .prepare(`SELECT * FROM trust_milestones WHERE milestone_type = 'override_revoked'`)
      .all();
    expect(milestones).toHaveLength(1);
  });

  // ── H1 Security Tests ────────────────────────────────────────────────────

  it("H1: rejects override from pipeline session", () => {
    expect(() =>
      manager.setOverride("write_file", "granted", "self-grant attempt", "pipeline-stage-deploy"),
    ).toThrow(/not an interactive session/);
  });

  it("H1: rejects override from subagent session", () => {
    expect(() =>
      manager.setOverride("service_restart", "granted", "subagent self-grant", "subagent-abc123"),
    ).toThrow(/not an interactive session/);
  });

  it("H1: rejects override from isolated session", () => {
    expect(() =>
      manager.setOverride(
        "config_change",
        "granted",
        "isolated self-grant",
        "isolated-session-xyz",
      ),
    ).toThrow(/not an interactive session/);
  });

  it("H1: accepts override from interactive main session", () => {
    // Should not throw — "main-session" doesn't match any pipeline patterns
    expect(() =>
      manager.setOverride("write_file", "granted", "legit grant", "main-session"),
    ).not.toThrow();
  });

  it("H1: override attempt from pipeline does not persist to DB", () => {
    try {
      manager.setOverride("service_restart", "granted", "sneak grant", "pipeline-task-010");
    } catch {
      // expected
    }
    const overrides = db
      .prepare(`SELECT * FROM trust_overrides WHERE category = 'service_restart'`)
      .all();
    expect(overrides).toHaveLength(0);
  });
});
