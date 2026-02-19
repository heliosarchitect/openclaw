import { describe, expect, it, beforeEach } from "vitest";
import type { IncidentDB } from "../incident-manager.js";
import { RunbookRegistry } from "../runbook-registry.js";

class MockDB implements IncidentDB {
  private store: Map<string, Record<string, unknown>> = new Map();
  async run(sql: string, params?: unknown[]): Promise<void> {
    if (sql.includes("CREATE")) return;
    if (sql.includes("INSERT")) {
      this.store.set(params?.[0] as string, {
        id: params?.[0],
        label: params?.[1],
        applies_to: params?.[2],
        mode: params?.[3],
        confidence: params?.[4],
        dry_run_count: params?.[5],
        auto_approve_whitelist: params?.[6],
        created_at: params?.[7],
        approved_at: params?.[8],
        schema_version: params?.[9],
      });
    }
    if (sql.includes("UPDATE")) {
      const id = params?.at(-1) as string;
      const row = this.store.get(id);
      if (row) {
        if (sql.includes("mode")) row.mode = params?.[0];
        if (sql.includes("approved_at")) row.approved_at = params?.[1];
        if (sql.includes("confidence")) row.confidence = params?.[2];
      }
    }
  }
  async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
    return null;
  }
  async all<T>(_sql: string): Promise<T[]> {
    return [];
  }
}

describe("RunbookRegistry", () => {
  let registry: RunbookRegistry;

  beforeEach(async () => {
    registry = new RunbookRegistry(new MockDB());
    await registry.init();
  });

  it("loads all 12 built-in runbooks", async () => {
    const all = await registry.listRunbooks();
    expect(all.length).toBe(12);
  });

  it("whitelisted runbooks start in auto_execute mode", async () => {
    const rotateLogs = registry.getRunbook("rb-rotate-logs");
    expect(rotateLogs?.mode).toBe("auto_execute");
    const gcTrigger = registry.getRunbook("rb-gc-trigger");
    expect(gcTrigger?.mode).toBe("auto_execute");
  });

  it("non-whitelisted runbooks start in dry_run mode", async () => {
    const restart = registry.getRunbook("rb-restart-service");
    expect(restart?.mode).toBe("dry_run");
  });

  it("getForAnomaly returns correct runbook", () => {
    const rb = registry.getForAnomaly("process_dead");
    expect(rb?.id).toBe("rb-restart-service");
  });

  it("approve transitions to auto_execute", async () => {
    await registry.approve("rb-restart-service");
    expect(registry.getRunbook("rb-restart-service")?.mode).toBe("auto_execute");
  });

  it("getDefinition returns built-in definition", () => {
    expect(registry.getDefinition("rb-rotate-logs")).not.toBeNull();
  });
});
