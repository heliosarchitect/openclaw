/**
 * Escalation Router — Tier 0–3 notification routing
 * Cortex v2.2.0
 */

import type { EscalationContext, EscalationTier, Incident, MetricsWriter } from "./types.js";

export interface EscalationDeps {
  sendSynapse: (body: string, priority: "info" | "action" | "urgent") => Promise<void>;
  sendSignal: (message: string) => Promise<void>;
  writeMetric: MetricsWriter;
}

export class EscalationRouter {
  constructor(private deps: EscalationDeps) {}

  async route(tier: EscalationTier, incident: Incident, context: EscalationContext): Promise<void> {
    switch (tier) {
      case 0:
        // Silent — metric only
        await this.deps.writeMetric("pipeline", {
          task_id: "heal_escalation_fired",
          stage: "tier0",
          result: "fired",
        });
        break;

      case 1: {
        // Synapse info
        const body = this.formatTier1(incident, context);
        await this.deps.sendSynapse(body, "info");
        await this.deps.writeMetric("pipeline", {
          task_id: "heal_escalation_fired",
          stage: "tier1",
          result: "fired",
        });
        break;
      }

      case 2: {
        // Synapse action (approval request)
        const body = this.formatTier2(incident, context);
        await this.deps.sendSynapse(body, "action");
        await this.deps.writeMetric("pipeline", {
          task_id: "heal_escalation_fired",
          stage: "tier2",
          result: "fired",
        });
        break;
      }

      case 3: {
        // Synapse + Signal (guaranteed)
        const synapseBody = this.formatTier3Synapse(incident, context);
        const signalBody = this.formatTier3Signal(incident, context);

        // Send both independently — neither blocks the other
        const results = await Promise.allSettled([
          this.deps.sendSynapse(synapseBody, "urgent"),
          this.deps.sendSignal(signalBody),
        ]);

        // Log Signal send status
        const signalResult = results[1];
        if (signalResult.status === "fulfilled") {
          await this.deps.writeMetric("pipeline", {
            task_id: "heal_signal_sent",
            stage: incident.anomaly_type,
            result: "sent",
          });
        }

        await this.deps.writeMetric("pipeline", {
          task_id: "heal_escalation_fired",
          stage: "tier3",
          result: "fired",
        });
        break;
      }
    }
  }

  /**
   * Determine escalation tier for an incident.
   */
  determineTier(
    incident: Incident,
    runbookExists: boolean,
    runbookMode: "dry_run" | "auto_execute" | null,
    confidence: number,
    confidenceThreshold: number,
    remediationFailed: boolean,
  ): EscalationTier {
    // Tier 3: No runbook, remediation failed, or critical severity
    if (!runbookExists || remediationFailed || incident.severity === "critical") {
      return 3;
    }
    // Tier 0: Known runbook, auto-execute, high confidence
    if (runbookMode === "auto_execute" && confidence >= confidenceThreshold) {
      return 0;
    }
    // Tier 2: Runbook exists but low confidence
    if (confidence < confidenceThreshold) {
      return 2;
    }
    // Tier 1: Runbook executed, uncertain result
    return 1;
  }

  private formatTier1(incident: Incident, ctx: EscalationContext): string {
    return [
      `🔧 Self-Healing — Action Taken`,
      `Anomaly: ${incident.anomaly_type} on ${incident.target_id}`,
      ctx.action_taken ? `Action: ${ctx.action_taken}` : "",
      ctx.verification_status ? `Verification: ${ctx.verification_status}` : "",
      `Incident: ${incident.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatTier2(incident: Incident, ctx: EscalationContext): string {
    return [
      `⚠️ Self-Healing — Approval Needed`,
      `Anomaly: ${incident.anomaly_type} on ${incident.target_id} (${incident.severity})`,
      `Proposed steps:`,
      ...(ctx.proposed_steps ?? []).map((s) => `  • ${s}`),
      ``,
      `Approve: cortex_heal approve ${incident.runbook_id}`,
      `Dismiss: cortex_heal dismiss ${incident.id}`,
    ].join("\n");
  }

  private formatTier3Synapse(incident: Incident, ctx: EscalationContext): string {
    return [
      `🚨 Self-Healing — ESCALATION (Tier 3)`,
      `Anomaly: ${incident.anomaly_type} on ${incident.target_id} (${incident.severity})`,
      ctx.failure_reason ? `Failure: ${ctx.failure_reason}` : "",
      ctx.matthew_decision_needed ? `Decision needed: ${ctx.matthew_decision_needed}` : "",
      `Incident: ${incident.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private formatTier3Signal(incident: Incident, ctx: EscalationContext): string {
    return [
      `🚨 Self-Healing Alert`,
      `What broke: ${incident.anomaly_type} on ${incident.target_id}`,
      ctx.action_taken
        ? `What was tried: ${ctx.action_taken}`
        : "What was tried: No automated fix available",
      ctx.failure_reason ? `What happened: ${ctx.failure_reason}` : "",
      ctx.matthew_decision_needed ? `What you need to decide: ${ctx.matthew_decision_needed}` : "",
      `Incident ID: ${incident.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}
