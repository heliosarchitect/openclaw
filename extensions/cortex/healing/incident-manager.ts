/**
 * Incident Manager — Lifecycle state machine + brain.db persistence
 * Cortex v2.2.0
 */

import { randomUUID } from "node:crypto";
import type {
  AnomalyType,
  HealthAnomaly,
  Incident,
  IncidentAuditEntry,
  IncidentState,
  TERMINAL_STATES,
} from "./types.js";

/**
 * Minimal DB interface — implemented by HealingEngine using CortexBridge's
 * Python execution or direct SQLite.
 */
export interface IncidentDB {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

const NON_TERMINAL = `state NOT IN ('resolved','self_resolved','dismissed')`;

function rowToIncident(row: Record<string, unknown>): Incident {
  return {
    id: row.id as string,
    anomaly_type: row.anomaly_type as AnomalyType,
    target_id: row.target_id as string,
    severity: row.severity as Incident["severity"],
    state: row.state as IncidentState,
    runbook_id: (row.runbook_id as string) ?? null,
    detected_at: row.detected_at as string,
    state_changed_at: row.state_changed_at as string,
    resolved_at: (row.resolved_at as string) ?? null,
    escalation_tier: row.escalation_tier != null ? Number(row.escalation_tier) : null,
    escalated_at: (row.escalated_at as string) ?? null,
    dismiss_until: (row.dismiss_until as string) ?? null,
    audit_trail: JSON.parse((row.audit_trail as string) || "[]") as IncidentAuditEntry[],
    details: JSON.parse((row.details as string) || "{}") as Record<string, unknown>,
    schema_version: Number(row.schema_version ?? 1),
  };
}

export class IncidentManager {
  constructor(private db: IncidentDB) {}

  /**
   * Initialize DB tables.
   */
  async init(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        anomaly_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'detected',
        runbook_id TEXT,
        detected_at TEXT NOT NULL,
        state_changed_at TEXT NOT NULL,
        resolved_at TEXT,
        escalation_tier INTEGER,
        escalated_at TEXT,
        dismiss_until TEXT,
        audit_trail TEXT NOT NULL DEFAULT '[]',
        details TEXT NOT NULL DEFAULT '{}',
        schema_version INTEGER NOT NULL DEFAULT 1
      )
    `);
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_incidents_open
      ON incidents(state, anomaly_type, target_id)
      WHERE ${NON_TERMINAL}
    `);
  }

  /**
   * Create or refresh an existing open incident.
   * Unique constraint: one open incident per (anomaly_type, target_id).
   */
  async upsertIncident(anomaly: HealthAnomaly): Promise<Incident> {
    // Check for dismissed
    if (await this.isDismissed(anomaly.anomaly_type, anomaly.target_id)) {
      // Return a synthetic dismissed incident (no-op)
      return {
        id: "dismissed",
        anomaly_type: anomaly.anomaly_type,
        target_id: anomaly.target_id,
        severity: anomaly.severity,
        state: "dismissed",
        runbook_id: null,
        detected_at: anomaly.detected_at,
        state_changed_at: anomaly.detected_at,
        resolved_at: null,
        escalation_tier: null,
        escalated_at: null,
        dismiss_until: null,
        audit_trail: [],
        details: anomaly.details,
        schema_version: 1,
      };
    }

    // Check for existing open incident
    const existing = await this.db.get<Record<string, unknown>>(
      `SELECT * FROM incidents WHERE anomaly_type = ? AND target_id = ? AND ${NON_TERMINAL}`,
      [anomaly.anomaly_type, anomaly.target_id],
    );

    const now = new Date().toISOString();

    if (existing) {
      // Refresh — update detected_at, add audit entry
      const incident = rowToIncident(existing);
      const entry: IncidentAuditEntry = {
        timestamp: now,
        state: incident.state,
        actor: "system",
        note: `Re-detected (${anomaly.source_id})`,
      };
      incident.audit_trail.push(entry);
      incident.details = { ...incident.details, ...anomaly.details };

      await this.db.run(
        `UPDATE incidents SET detected_at = ?, audit_trail = ?, details = ? WHERE id = ?`,
        [now, JSON.stringify(incident.audit_trail), JSON.stringify(incident.details), incident.id],
      );
      return incident;
    }

    // Create new incident
    const id = randomUUID();
    const audit: IncidentAuditEntry[] = [
      {
        timestamp: now,
        state: "detected",
        actor: "system",
        note: `Anomaly detected via ${anomaly.source_id}`,
      },
    ];

    const incident: Incident = {
      id,
      anomaly_type: anomaly.anomaly_type,
      target_id: anomaly.target_id,
      severity: anomaly.severity,
      state: "detected",
      runbook_id: anomaly.remediation_hint || null,
      detected_at: now,
      state_changed_at: now,
      resolved_at: null,
      escalation_tier: null,
      escalated_at: null,
      dismiss_until: null,
      audit_trail: audit,
      details: anomaly.details,
      schema_version: 1,
    };

    await this.db.run(
      `INSERT INTO incidents (id, anomaly_type, target_id, severity, state, runbook_id,
        detected_at, state_changed_at, audit_trail, details, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        incident.anomaly_type,
        incident.target_id,
        incident.severity,
        incident.state,
        incident.runbook_id,
        incident.detected_at,
        incident.state_changed_at,
        JSON.stringify(incident.audit_trail),
        JSON.stringify(incident.details),
        1,
      ],
    );

    return incident;
  }

  /**
   * Transition incident state. Appends audit entry.
   */
  async transition(
    incidentId: string,
    newState: IncidentState,
    note: string,
    actor: "system" | "matthew" = "system",
  ): Promise<void> {
    const row = await this.db.get<Record<string, unknown>>("SELECT * FROM incidents WHERE id = ?", [
      incidentId,
    ]);
    if (!row) return;

    const incident = rowToIncident(row);
    const now = new Date().toISOString();
    const entry: IncidentAuditEntry = { timestamp: now, state: newState, actor, note };
    incident.audit_trail.push(entry);

    const updates: Record<string, unknown> = {
      state: newState,
      state_changed_at: now,
      audit_trail: JSON.stringify(incident.audit_trail),
    };

    if (newState === "resolved" || newState === "self_resolved") {
      updates.resolved_at = now;
    }
    if (newState === "escalated") {
      updates.escalated_at = now;
    }

    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const values = [...Object.values(updates), incidentId];
    await this.db.run(`UPDATE incidents SET ${setClauses} WHERE id = ?`, values);
  }

  async getOpenIncidents(): Promise<Incident[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM incidents WHERE ${NON_TERMINAL} ORDER BY detected_at DESC`,
    );
    return rows.map(rowToIncident);
  }

  async getIncident(id: string): Promise<Incident | null> {
    const row = await this.db.get<Record<string, unknown>>("SELECT * FROM incidents WHERE id = ?", [
      id,
    ]);
    return row ? rowToIncident(row) : null;
  }

  async isDismissed(anomalyType: AnomalyType, targetId: string): Promise<boolean> {
    const row = await this.db.get<Record<string, unknown>>(
      `SELECT dismiss_until FROM incidents
       WHERE anomaly_type = ? AND target_id = ? AND state = 'dismissed' AND dismiss_until > ?`,
      [anomalyType, targetId, new Date().toISOString()],
    );
    return row != null;
  }

  async dismiss(incidentId: string, reason: string, windowMs: number): Promise<void> {
    const until = new Date(Date.now() + windowMs).toISOString();
    await this.db.run("UPDATE incidents SET dismiss_until = ? WHERE id = ?", [until, incidentId]);
    await this.transition(
      incidentId,
      "dismissed",
      `Dismissed: ${reason} (until ${until})`,
      "matthew",
    );
  }

  async selfResolve(incidentId: string): Promise<void> {
    await this.transition(
      incidentId,
      "self_resolved",
      "Anomaly cleared before remediation executed",
    );
  }

  async setEscalationTier(incidentId: string, tier: number): Promise<void> {
    await this.db.run("UPDATE incidents SET escalation_tier = ?, escalated_at = ? WHERE id = ?", [
      tier,
      new Date().toISOString(),
      incidentId,
    ]);
  }
}
