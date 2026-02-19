/**
 * Self-Healing Engine — Main orchestrator
 * Cortex v2.2.0
 *
 * Event-driven: receives SourceReading objects from PollingEngine + own probes.
 * Implements detect → diagnose → remediate → verify → escalate pipeline.
 */

import type { SourceReading } from "../predictive/types.js";
import type {
  EscalationContext,
  HealingEngineConfig,
  HealthAnomaly,
  Incident,
  MetricsWriter,
  Runbook,
  RunbookExecutionResult,
} from "./types.js";
import { AnomalyClassifier } from "./anomaly-classifier.js";
import { EscalationRouter, type EscalationDeps } from "./escalation-router.js";
import { IncidentManager, type IncidentDB } from "./incident-manager.js";
import { HealingProbeRegistry } from "./probe-registry.js";
import { RunbookExecutor } from "./runbook-executor.js";
import { RunbookRegistry } from "./runbook-registry.js";

export interface HealingEngineDeps {
  db: IncidentDB;
  writeMetric: MetricsWriter;
  sendSynapse: (body: string, priority: "info" | "action" | "urgent") => Promise<void>;
  sendSignal: (message: string) => Promise<void>;
  dbPath?: string;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

export class HealingEngine {
  private classifier: AnomalyClassifier;
  private incidentManager: IncidentManager;
  private runbookRegistry: RunbookRegistry;
  private runbookExecutor: RunbookExecutor;
  private escalationRouter: EscalationRouter;
  private probeRegistry: HealingProbeRegistry;
  private config: HealingEngineConfig;
  private logger: NonNullable<HealingEngineDeps["logger"]>;
  private deps: HealingEngineDeps;
  private started = false;

  constructor(config: HealingEngineConfig, deps: HealingEngineDeps) {
    this.config = config;
    this.deps = deps;
    this.logger = deps.logger ?? {};

    this.classifier = new AnomalyClassifier();
    this.incidentManager = new IncidentManager(deps.db);
    this.runbookRegistry = new RunbookRegistry(
      deps.db,
      config.auto_execute_whitelist,
      config.dry_run_graduation_count,
    );
    this.probeRegistry = new HealingProbeRegistry(config, deps.dbPath);

    this.runbookExecutor = new RunbookExecutor({
      incidentManager: this.incidentManager,
      getProbe: (sourceId) => this.probeRegistry.getProbe(sourceId),
      verificationIntervalMs: config.verification_interval_ms,
      // MED-002: inject classifier to avoid require() in ESM context in runbook-executor.ts
      classifier: this.classifier,
    });

    const escalationDeps: EscalationDeps = {
      sendSynapse: deps.sendSynapse,
      sendSignal: deps.sendSignal,
      writeMetric: deps.writeMetric,
    };
    this.escalationRouter = new EscalationRouter(escalationDeps);
  }

  /**
   * Initialize DB tables, load runbooks, start probes.
   */
  async start(): Promise<void> {
    if (this.started) return;

    await this.incidentManager.init();
    await this.runbookRegistry.init();

    // Wire probe readings into onReading
    this.probeRegistry.setReadingCallback((reading) => this.onReading(reading));
    await this.probeRegistry.start();

    this.started = true;
    this.logger.info?.(
      `[Heal] Self-healing engine started: ${this.probeRegistry.probeCount} probes, ${(await this.runbookRegistry.listRunbooks()).length} runbooks`,
    );
  }

  async stop(): Promise<void> {
    await this.probeRegistry.stop();
    this.started = false;
  }

  /**
   * Process a SourceReading — called by PollingEngine callback + own probes.
   */
  async onReading(reading: SourceReading): Promise<void> {
    try {
      const anomalies = this.classifier.classify(reading);
      for (const anomaly of anomalies) {
        await this.deps.writeMetric("pipeline", {
          task_id: "heal_anomaly_detected",
          stage: anomaly.anomaly_type,
          result: "detected",
        });

        const incident = await this.incidentManager.upsertIncident(anomaly);
        if (incident.state === "dismissed" || incident.id === "dismissed") continue;

        // Only handle newly detected incidents (not re-detections of in-progress ones)
        if (incident.state === "detected") {
          await this.handleIncident(incident, anomaly);
        }
      }
    } catch (err) {
      this.logger.warn?.(`[Heal] onReading error: ${err}`);
    }
  }

  /**
   * Core remediation flow.
   */
  private async handleIncident(incident: Incident, anomaly: HealthAnomaly): Promise<void> {
    await this.incidentManager.transition(
      incident.id,
      "diagnosing",
      `Looking up runbook for ${anomaly.anomaly_type}`,
    );

    const runbook =
      this.runbookRegistry.getRunbook(incident.runbook_id ?? "") ??
      this.runbookRegistry.getForAnomaly(anomaly.anomaly_type);

    if (!runbook) {
      // No runbook → tier 3 escalation
      const tier = this.escalationRouter.determineTier(
        incident,
        false,
        null,
        0,
        this.config.confidence_auto_execute,
        false,
      );
      await this.incidentManager.setEscalationTier(incident.id, tier);
      await this.escalationRouter.route(tier, incident, {
        matthew_decision_needed: `No automated runbook for ${anomaly.anomaly_type} on ${anomaly.target_id}`,
      });
      await this.incidentManager.transition(incident.id, "escalated", "No runbook available");
      return;
    }

    // Determine tier before execution
    const tier = this.escalationRouter.determineTier(
      incident,
      true,
      runbook.mode,
      runbook.confidence,
      this.config.confidence_auto_execute,
      false,
    );

    // Tier 2: needs approval — don't execute
    if (tier === 2) {
      const definition = this.runbookRegistry.getDefinition(runbook.id);
      const steps = definition ? definition.build(anomaly) : [];
      await this.incidentManager.setEscalationTier(incident.id, 2);
      await this.escalationRouter.route(2, incident, {
        proposed_steps: steps.map((s) => s.description),
      });
      await this.incidentManager.transition(incident.id, "escalated", "Awaiting approval (tier 2)");
      return;
    }

    // Execute runbook
    await this.deps.writeMetric("pipeline", {
      task_id: "heal_remediation_started",
      stage: runbook.id,
      result: "started",
    });

    const definition = this.runbookRegistry.getDefinition(runbook.id);
    const result = await this.runbookExecutor.execute(runbook, definition, incident, anomaly);

    // Record execution
    await this.runbookRegistry.recordExecution(runbook.id, result.success);

    if (result.success) {
      await this.deps.writeMetric("pipeline", {
        task_id: "heal_remediation_success",
        stage: runbook.id,
        result: "pass",
      });

      // Check for graduation
      const graduated = await this.runbookRegistry.checkGraduation(runbook.id);
      if (graduated) {
        await this.deps.writeMetric("pipeline", {
          task_id: "heal_runbook_graduated",
          stage: runbook.id,
          result: "graduated",
        });
      }

      // Tier 0 → silent; Tier 1 → Synapse summary
      if (tier === 0) {
        await this.escalationRouter.route(0, incident, {});
      } else {
        await this.escalationRouter.route(1, incident, {
          action_taken: `Executed ${runbook.id} (${result.mode})`,
          verification_status: result.verification_passed ? "passed" : "pending",
        });
      }
    } else {
      await this.deps.writeMetric("pipeline", {
        task_id: "heal_remediation_failed",
        stage: runbook.id,
        result: "fail",
      });

      // Escalate
      const failTier = this.escalationRouter.determineTier(
        incident,
        true,
        runbook.mode,
        runbook.confidence,
        this.config.confidence_auto_execute,
        true,
      );
      await this.incidentManager.setEscalationTier(incident.id, failTier);
      await this.escalationRouter.route(failTier, incident, {
        action_taken: `Attempted ${runbook.id}`,
        failure_reason: result.steps_executed.at(-1)?.output ?? "Unknown",
        matthew_decision_needed: `Automated fix for ${anomaly.anomaly_type} failed — manual intervention needed`,
      });
    }
  }

  // ─── cortex_heal tool backing methods ───

  async getStatus(): Promise<{
    open_incidents: Incident[];
    runbook_summary: { total: number; auto_execute: number; dry_run: number };
  }> {
    const incidents = await this.incidentManager.getOpenIncidents();
    const runbooks = await this.runbookRegistry.listRunbooks();
    return {
      open_incidents: incidents,
      runbook_summary: {
        total: runbooks.length,
        auto_execute: runbooks.filter((r) => r.mode === "auto_execute").length,
        dry_run: runbooks.filter((r) => r.mode === "dry_run").length,
      },
    };
  }

  async listRunbooks(): Promise<Runbook[]> {
    return this.runbookRegistry.listRunbooks();
  }

  async approveRunbook(runbookId: string): Promise<void> {
    await this.runbookRegistry.approve(runbookId);
  }

  async dryRunRunbook(runbookId: string, targetId: string): Promise<string> {
    const rb = this.runbookRegistry.getRunbook(runbookId);
    if (!rb) return `Runbook ${runbookId} not found`;
    const def = this.runbookRegistry.getDefinition(runbookId);
    if (!def) return `No definition for ${runbookId}`;

    const fakeAnomaly: HealthAnomaly = {
      id: "dry-run",
      anomaly_type: rb.applies_to[0],
      target_id: targetId,
      severity: "medium",
      detected_at: new Date().toISOString(),
      source_id: "dry-run",
      details: {},
      remediation_hint: runbookId,
    };

    const steps = def.build(fakeAnomaly);
    const descriptions: string[] = [];
    for (const step of steps) {
      descriptions.push(`[${step.id}] ${await step.dry_run()}`);
    }
    return descriptions.join("\n");
  }

  async executeRunbook(
    runbookId: string,
    targetId: string,
    confirm: boolean,
  ): Promise<RunbookExecutionResult | { error: string }> {
    if (!confirm)
      return { error: "Safety check: must pass confirm=true to force-execute a runbook" };

    const rb = this.runbookRegistry.getRunbook(runbookId);
    if (!rb) return { error: `Runbook ${runbookId} not found` };

    const fakeAnomaly: HealthAnomaly = {
      id: "manual",
      anomaly_type: rb.applies_to[0],
      target_id: targetId,
      severity: "medium",
      detected_at: new Date().toISOString(),
      source_id: "manual",
      details: {},
      remediation_hint: runbookId,
    };

    const incident = await this.incidentManager.upsertIncident(fakeAnomaly);
    const def = this.runbookRegistry.getDefinition(runbookId);
    return this.runbookExecutor.execute(rb, def, incident, fakeAnomaly);
  }

  async recordFix(incidentId: string, description: string): Promise<string> {
    const incident = await this.incidentManager.getIncident(incidentId);
    if (!incident) return "Incident not found";

    await this.incidentManager.transition(
      incidentId,
      "resolved",
      `Manual fix: ${description}`,
      "matthew",
    );

    const rbId = await this.runbookRegistry.createCustomRunbook(incident.anomaly_type, description);
    await this.deps.writeMetric("pipeline", {
      task_id: "heal_runbook_created",
      stage: rbId,
      result: "created",
    });

    return `Incident resolved. Draft runbook ${rbId} created in dry_run mode.`;
  }

  async dismissIncident(incidentId: string, reason: string): Promise<void> {
    await this.incidentManager.dismiss(incidentId, reason, this.config.incident_dismiss_window_ms);
  }
}
