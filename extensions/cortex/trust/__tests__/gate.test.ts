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

  // --- sanitizeCommand coverage (FINDING-004) ---
  // Tests verify secrets are scrubbed in decision_log tool_params_summary

  function getSummary(db: Database.Database, decisionId: string): string {
    const row = db
      .prepare(`SELECT tool_params_summary FROM decision_log WHERE decision_id = ?`)
      .get(decisionId) as { tool_params_summary: string };
    return row.tool_params_summary;
  }

  describe("sanitizeCommand (via decision_log)", () => {
    it("redacts Bearer tokens", () => {
      const d = gate.check(
        "exec",
        { command: "curl -H 'Authorization: Bearer sk-abc123xyz'" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("sk-abc123xyz");
      expect(s).toContain("***REDACTED***");
    });

    it("redacts curl -H Authorization headers", () => {
      const d = gate.check("exec", { command: 'curl -H "Authorization: Token mytoken123"' }, "s");
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("mytoken123");
    });

    it("redacts key=value and token=value patterns", () => {
      const d = gate.check("exec", { command: "tool --config api_key=sk_live_abcdef" }, "s");
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("sk_live_abcdef");
    });

    it("redacts --password and --token CLI flags", () => {
      const d = gate.check("exec", { command: "mysql --password supersecret --host db" }, "s");
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("supersecret");
    });

    it("redacts AWS access key IDs (AKIA...)", () => {
      const d = gate.check(
        "exec",
        { command: "aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(s).toContain("***AWS_KEY***");
    });

    it("redacts aws_secret_access_key", () => {
      const d = gate.check(
        "exec",
        { command: "export aws_secret_access_key=wJalrXUtnFEMI/K7MDENG" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("wJalrXUtnFEMI");
    });

    it("redacts GitHub tokens (ghp_)", () => {
      const d = gate.check(
        "exec",
        { command: "gh auth login --with-token ghp_ABCDEFghijklmnop12345678" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("ghp_ABCDEFghijklmnop12345678");
      expect(s).toContain("***GH_TOKEN***");
    });

    it("redacts GitLab tokens (glpat-)", () => {
      const d = gate.check(
        "exec",
        { command: "git clone https://glpat-abcdefghijklmnopqrstuv@gitlab.com/repo" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("glpat-abcdefghijklmnopqrstuv");
      expect(s).toContain("***GL_TOKEN***");
    });

    it("redacts Slack tokens (xoxb-)", () => {
      const d = gate.check(
        "exec",
        { command: "curl -H 'Authorization: Bearer xoxb-123-456-abcdefghij'" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("xoxb-123-456-abcdefghij");
    });

    it("redacts URLs with embedded credentials", () => {
      const d = gate.check(
        "exec",
        { command: "psql postgres://admin:p4ssw0rd@db.host:5432/mydb" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("p4ssw0rd");
      expect(s).toContain("***CREDS***@");
    });

    it("redacts environment variable exports with secret names", () => {
      const d = gate.check("exec", { command: "export MY_API_KEY=abcdef123456" }, "s");
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("abcdef123456");
    });

    it("redacts JWT tokens", () => {
      const d = gate.check(
        "exec",
        {
          command:
            "curl -H 'Auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'",
        },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
      expect(s).toContain("***JWT***");
    });

    it("redacts long hex secrets", () => {
      const d = gate.check(
        "exec",
        { command: "echo aabbccddee00112233445566778899aabbccddee00" },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("aabbccddee00112233445566778899aabbccddee00");
      expect(s).toContain("***HEX_SECRET***");
    });

    it("redacts 1Password references", () => {
      const d = gate.check("exec", { command: "op read op://vault/item/field" }, "s");
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("op://vault/item/field");
      expect(s).toContain("***1PASS_REF***");
    });

    it("redacts PEM private keys", () => {
      const d = gate.check(
        "exec",
        {
          command:
            "echo '-----BEGIN PRIVATE KEY-----\nMIIE...base64...\n-----END PRIVATE KEY-----'",
        },
        "s",
      );
      const s = getSummary(db, d.decision_id);
      expect(s).not.toContain("MIIE");
      expect(s).toContain("***PEM_PRIVATE_KEY***");
    });
  });
});
