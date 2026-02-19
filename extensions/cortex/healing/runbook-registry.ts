/**
 * Runbook Registry — Catalog of all remediation procedures
 * Cortex v2.2.0
 */

import type { IncidentDB } from "./incident-manager.js";
import type { AnomalyType, Runbook, RunbookDefinition, RunbookMode } from "./types.js";
import { RbClearPhantom } from "./runbooks/rb-clear-phantom.js";
import { RbDbEmergency } from "./runbooks/rb-db-emergency.js";
import { RbEmergencyCleanup } from "./runbooks/rb-emergency-cleanup.js";
import { RbForceGc } from "./runbooks/rb-force-gc.js";
import { RbGatewayRestart } from "./runbooks/rb-gateway-restart.js";
import { RbGcTrigger } from "./runbooks/rb-gc-trigger.js";
import { RbKickPipeline } from "./runbooks/rb-kick-pipeline.js";
import { RbKillZombie } from "./runbooks/rb-kill-zombie.js";
import { RbProbeThenAlert } from "./runbooks/rb-probe-then-alert.js";
import { RbRestartAugur } from "./runbooks/rb-restart-augur.js";
// Import built-in runbook definitions
import { RbRestartService } from "./runbooks/rb-restart-service.js";
import { RbRotateLogs } from "./runbooks/rb-rotate-logs.js";

const BUILTIN_DEFINITIONS: RunbookDefinition[] = [
  new RbRestartService(),
  new RbKillZombie(),
  new RbRestartAugur(),
  new RbClearPhantom(),
  new RbKickPipeline(),
  new RbProbeThenAlert(),
  new RbRotateLogs(),
  new RbEmergencyCleanup(),
  new RbGcTrigger(),
  new RbForceGc(),
  new RbDbEmergency(),
  new RbGatewayRestart(),
];

export class RunbookRegistry {
  private runbooks: Map<string, Runbook> = new Map();
  private definitions: Map<string, RunbookDefinition> = new Map();

  constructor(
    private db: IncidentDB,
    private autoExecuteWhitelist: string[] = ["rb-rotate-logs", "rb-gc-trigger"],
    private graduationCount: number = 3,
  ) {
    for (const def of BUILTIN_DEFINITIONS) {
      this.definitions.set(def.id, def);
    }
  }

  /**
   * Initialize DB table and load persisted state.
   */
  async init(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS runbooks (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        applies_to TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'dry_run',
        confidence REAL NOT NULL DEFAULT 0.5,
        dry_run_count INTEGER NOT NULL DEFAULT 0,
        last_executed_at TEXT,
        last_succeeded_at TEXT,
        auto_approve_whitelist INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      )
    `);

    await this.load();
  }

  async load(): Promise<void> {
    const now = new Date().toISOString();

    // Load persisted state
    const rows = await this.db.all<Record<string, unknown>>("SELECT * FROM runbooks");
    const persistedState = new Map(rows.map((r) => [r.id as string, r]));

    // Merge built-in definitions with persisted state
    for (const def of this.definitions.values()) {
      const persisted = persistedState.get(def.id);
      const isWhitelisted =
        def.auto_approve_whitelist || this.autoExecuteWhitelist.includes(def.id);

      const runbook: Runbook = {
        id: def.id,
        label: def.label,
        applies_to: def.applies_to,
        mode: persisted
          ? (persisted.mode as RunbookMode)
          : isWhitelisted
            ? "auto_execute"
            : "dry_run",
        confidence: persisted ? Number(persisted.confidence) : isWhitelisted ? 1.0 : 0.5,
        dry_run_count: persisted ? Number(persisted.dry_run_count) : 0,
        last_executed_at: (persisted?.last_executed_at as string) ?? null,
        last_succeeded_at: (persisted?.last_succeeded_at as string) ?? null,
        auto_approve_whitelist: isWhitelisted,
        steps: [], // Steps are built per-anomaly
        created_at: (persisted?.created_at as string) ?? now,
        approved_at: (persisted?.approved_at as string) ?? (isWhitelisted ? now : null),
        schema_version: 1,
      };

      this.runbooks.set(def.id, runbook);

      // Persist if not yet in DB
      if (!persisted) {
        await this.db.run(
          `INSERT OR IGNORE INTO runbooks (id, label, applies_to, mode, confidence, dry_run_count,
            auto_approve_whitelist, created_at, approved_at, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runbook.id,
            runbook.label,
            JSON.stringify(runbook.applies_to),
            runbook.mode,
            runbook.confidence,
            runbook.dry_run_count,
            isWhitelisted ? 1 : 0,
            runbook.created_at,
            runbook.approved_at,
            1,
          ],
        );
      }
    }

    // Also load any custom runbooks (from record_fix)
    for (const [id, row] of persistedState) {
      if (!this.runbooks.has(id)) {
        this.runbooks.set(id, {
          id,
          label: row.label as string,
          applies_to: JSON.parse((row.applies_to as string) || "[]") as AnomalyType[],
          mode: row.mode as RunbookMode,
          confidence: Number(row.confidence),
          dry_run_count: Number(row.dry_run_count),
          last_executed_at: (row.last_executed_at as string) ?? null,
          last_succeeded_at: (row.last_succeeded_at as string) ?? null,
          auto_approve_whitelist: Boolean(row.auto_approve_whitelist),
          steps: [],
          created_at: row.created_at as string,
          approved_at: (row.approved_at as string) ?? null,
          schema_version: 1,
        });
      }
    }
  }

  getRunbook(id: string): Runbook | null {
    return this.runbooks.get(id) ?? null;
  }

  getDefinition(id: string): RunbookDefinition | null {
    return this.definitions.get(id) ?? null;
  }

  getForAnomaly(anomalyType: AnomalyType): Runbook | null {
    for (const rb of this.runbooks.values()) {
      if (rb.applies_to.includes(anomalyType)) return rb;
    }
    return null;
  }

  async approve(runbookId: string): Promise<void> {
    const rb = this.runbooks.get(runbookId);
    if (!rb) return;
    rb.mode = "auto_execute";
    rb.approved_at = new Date().toISOString();
    rb.confidence = Math.max(rb.confidence, 0.8);
    await this.db.run(
      "UPDATE runbooks SET mode = ?, approved_at = ?, confidence = ? WHERE id = ?",
      [rb.mode, rb.approved_at, rb.confidence, runbookId],
    );
  }

  async recordExecution(runbookId: string, success: boolean): Promise<void> {
    const rb = this.runbooks.get(runbookId);
    if (!rb) return;
    const now = new Date().toISOString();
    rb.last_executed_at = now;
    if (success) {
      rb.last_succeeded_at = now;
      if (rb.mode === "dry_run") {
        rb.dry_run_count++;
      }
    }
    await this.db.run(
      "UPDATE runbooks SET last_executed_at = ?, last_succeeded_at = ?, dry_run_count = ? WHERE id = ?",
      [rb.last_executed_at, rb.last_succeeded_at, rb.dry_run_count, runbookId],
    );
  }

  async checkGraduation(runbookId: string): Promise<boolean> {
    const rb = this.runbooks.get(runbookId);
    if (!rb || rb.mode === "auto_execute") return false;
    if (rb.dry_run_count >= this.graduationCount) {
      await this.approve(runbookId);
      return true;
    }
    return false;
  }

  async listRunbooks(): Promise<Runbook[]> {
    return Array.from(this.runbooks.values());
  }

  /**
   * Create a custom runbook from a manual fix.
   */
  async createCustomRunbook(anomalyType: AnomalyType, description: string): Promise<string> {
    const id = `rb-matthew-fix-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const rb: Runbook = {
      id,
      label: `Manual fix: ${description.slice(0, 60)}`,
      applies_to: [anomalyType],
      mode: "dry_run",
      confidence: 0.5,
      dry_run_count: 0,
      last_executed_at: null,
      last_succeeded_at: null,
      auto_approve_whitelist: false,
      steps: [],
      created_at: now,
      approved_at: null,
      schema_version: 1,
    };

    this.runbooks.set(id, rb);
    await this.db.run(
      `INSERT INTO runbooks (id, label, applies_to, mode, confidence, dry_run_count,
        auto_approve_whitelist, created_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, rb.label, JSON.stringify(rb.applies_to), "dry_run", 0.5, 0, 0, now, 1],
    );

    return id;
  }
}
