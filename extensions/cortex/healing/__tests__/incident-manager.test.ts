import { describe, expect, it, beforeEach } from "vitest";
import type { HealthAnomaly } from "../types.js";
import { IncidentManager, type IncidentDB } from "../incident-manager.js";

// In-memory SQLite-like store for testing
class MockDB implements IncidentDB {
  private store: Map<string, Record<string, unknown>> = new Map();

  async run(sql: string, params?: unknown[]): Promise<void> {
    if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return;

    if (sql.includes("INSERT")) {
      const id = params?.[0] as string;
      const cols = [
        "id",
        "anomaly_type",
        "target_id",
        "severity",
        "state",
        "runbook_id",
        "detected_at",
        "state_changed_at",
        "audit_trail",
        "details",
        "schema_version",
      ];
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = params?.[i];
      });
      this.store.set(id, row);
      return;
    }

    if (sql.includes("UPDATE")) {
      const id = params?.at(-1) as string;
      const row = this.store.get(id);
      if (!row) return;
      // Simple field extraction from SET clause
      const setClause = sql.match(/SET (.+?) WHERE/)?.[1] ?? "";
      const fields = setClause.split(",").map((f) => f.trim().split("=")[0].trim());
      const values = params?.slice(0, -1) ?? [];
      fields.forEach((f, i) => {
        row[f] = values[i];
      });
    }
  }

  async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
    for (const row of this.store.values()) {
      if (sql.includes("anomaly_type") && sql.includes("target_id")) {
        if (row.anomaly_type === params?.[0] && row.target_id === params?.[1]) {
          if (sql.includes("state = 'dismissed'") && row.state !== "dismissed") continue;
          if (
            sql.includes("NOT IN") &&
            ["resolved", "self_resolved", "dismissed"].includes(row.state as string)
          )
            continue;
          return row as T;
        }
      }
      if (sql.includes("WHERE id =") && row.id === params?.[0]) {
        return row as T;
      }
    }
    return null;
  }

  async all<T>(sql: string, _params?: unknown[]): Promise<T[]> {
    const results: T[] = [];
    for (const row of this.store.values()) {
      if (
        sql.includes("NOT IN") &&
        ["resolved", "self_resolved", "dismissed"].includes(row.state as string)
      )
        continue;
      results.push(row as T);
    }
    return results;
  }
}

function makeAnomaly(type = "process_dead", target = "augur-executor"): HealthAnomaly {
  return {
    id: "test-anomaly",
    anomaly_type: type as any,
    target_id: target,
    severity: "critical",
    detected_at: new Date().toISOString(),
    source_id: "test",
    details: { test: true },
    remediation_hint: "rb-restart-service",
  };
}

describe("IncidentManager", () => {
  let db: MockDB;
  let mgr: IncidentManager;

  beforeEach(async () => {
    db = new MockDB();
    mgr = new IncidentManager(db);
    await mgr.init();
  });

  it("creates a new incident on first anomaly", async () => {
    const incident = await mgr.upsertIncident(makeAnomaly());
    expect(incident.state).toBe("detected");
    expect(incident.anomaly_type).toBe("process_dead");
    expect(incident.audit_trail).toHaveLength(1);
  });

  it("refreshes existing open incident (no duplicate)", async () => {
    const i1 = await mgr.upsertIncident(makeAnomaly());
    const i2 = await mgr.upsertIncident(makeAnomaly());
    expect(i2.id).toBe(i1.id); // Same incident
    expect(i2.audit_trail.length).toBeGreaterThan(i1.audit_trail.length);
  });

  it("transitions state", async () => {
    const incident = await mgr.upsertIncident(makeAnomaly());
    await mgr.transition(incident.id, "diagnosing", "Looking up runbook");
    const updated = await mgr.getIncident(incident.id);
    expect(updated?.state).toBe("diagnosing");
  });

  it("returns open incidents", async () => {
    await mgr.upsertIncident(makeAnomaly("process_dead", "augur"));
    await mgr.upsertIncident(makeAnomaly("disk_pressure", "disk:/"));
    const open = await mgr.getOpenIncidents();
    expect(open).toHaveLength(2);
  });

  it("selfResolve marks as self_resolved", async () => {
    const incident = await mgr.upsertIncident(makeAnomaly());
    await mgr.selfResolve(incident.id);
    const updated = await mgr.getIncident(incident.id);
    expect(updated?.state).toBe("self_resolved");
  });
});
