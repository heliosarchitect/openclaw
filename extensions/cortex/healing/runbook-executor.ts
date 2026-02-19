/**
 * Runbook Executor — Step-by-step execution with verification
 * Cortex v2.2.0
 *
 * MED-002 fix: AnomalyClassifier is now injected as a constructor dependency
 * (import type only — avoids circular dependency at runtime) rather than using
 * require() which is illegal in ESM context and silently breaks verification probes.
 */

import type { DataSourceAdapter, SourceReading } from "../predictive/types.js";
import type { AnomalyClassifier } from "./anomaly-classifier.js";
import type { IncidentManager } from "./incident-manager.js";
import type {
  HealthAnomaly,
  Incident,
  Runbook,
  RunbookContext,
  RunbookDefinition,
  RunbookExecutionResult,
  RunbookMode,
  RunbookStepResult,
} from "./types.js";

export interface ExecutorDeps {
  incidentManager: IncidentManager;
  getProbe: (sourceId: string) => DataSourceAdapter | undefined;
  verificationIntervalMs: number;
  /** MED-002: injected to avoid require() in ESM — passed from HealingEngine.constructor */
  classifier: AnomalyClassifier;
}

export class RunbookExecutor {
  constructor(private deps: ExecutorDeps) {}

  /**
   * Execute a runbook for an incident.
   * 1. Re-probe to verify anomaly still active
   * 2. Run steps (dry_run or auto_execute)
   * 3. Post-execution verification
   */
  async execute(
    runbook: Runbook,
    definition: RunbookDefinition | null,
    incident: Incident,
    anomaly: HealthAnomaly,
    options?: { force_dry_run?: boolean },
  ): Promise<RunbookExecutionResult> {
    const mode: RunbookMode = options?.force_dry_run ? "dry_run" : runbook.mode;
    const isDryRun = mode === "dry_run";

    // Build steps from definition
    const steps = definition ? definition.build(anomaly) : [];
    if (steps.length === 0) {
      return {
        success: false,
        mode,
        steps_executed: [],
        verification_passed: null,
        escalation_needed: true,
      };
    }

    // Step 1: Re-probe — verify anomaly still active (NFR-002)
    const probe = this.deps.getProbe(anomaly.source_id);
    if (probe && !isDryRun) {
      try {
        const reading = await probe.poll();
        if (reading.available && this.readingIsClear(reading, anomaly)) {
          await this.deps.incidentManager.selfResolve(incident.id);
          return {
            success: true,
            mode,
            steps_executed: [],
            verification_passed: true,
            escalation_needed: false,
          };
        }
      } catch {
        // Probe failed — proceed with remediation
      }
    }

    // Step 2: Execute steps
    await this.deps.incidentManager.transition(
      incident.id,
      "remediating",
      `Executing ${runbook.id} (${mode})`,
    );

    const context: RunbookContext = {
      anomaly,
      incident_id: incident.id,
      dry_run: isDryRun,
    };

    const stepResults: RunbookStepResult[] = [];
    let allSuccess = true;

    for (const step of steps) {
      try {
        let result: RunbookStepResult;
        if (isDryRun) {
          const description = await step.dry_run();
          result = {
            step_id: step.id,
            status: "success",
            output: `[DRY RUN] ${description}`,
            artifacts: [],
            duration_ms: 0,
          };
        } else {
          const start = Date.now();
          // Execute with timeout
          result = await Promise.race([
            step.execute(context),
            new Promise<RunbookStepResult>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Step ${step.id} timed out after ${step.timeout_ms}ms`)),
                step.timeout_ms,
              ),
            ),
          ]);
          result.duration_ms = Date.now() - start;
        }

        stepResults.push(result);

        if (result.status === "failed") {
          allSuccess = false;
          break;
        }
      } catch (err) {
        stepResults.push({
          step_id: step.id,
          status: "failed",
          output: `Error: ${err instanceof Error ? err.message : String(err)}`,
          artifacts: [],
          duration_ms: 0,
        });
        allSuccess = false;
        break;
      }
    }

    // Step 3: Post-execution verification (live mode only)
    let verificationPassed: boolean | null = null;
    if (!isDryRun && allSuccess && probe) {
      await this.deps.incidentManager.transition(
        incident.id,
        "verifying",
        "Verification probe scheduled",
      );

      await this.sleep(this.deps.verificationIntervalMs);

      try {
        const reading = await probe.poll();
        verificationPassed = reading.available && this.readingIsClear(reading, anomaly);
      } catch {
        verificationPassed = false;
      }

      if (verificationPassed) {
        await this.deps.incidentManager.transition(incident.id, "resolved", "Verification passed");
      } else {
        await this.deps.incidentManager.transition(
          incident.id,
          "remediation_failed",
          "Verification probe still shows anomaly",
        );
      }
    }

    const escalationNeeded = !isDryRun && (!allSuccess || verificationPassed === false);

    if (!isDryRun && !allSuccess) {
      await this.deps.incidentManager.transition(
        incident.id,
        "remediation_failed",
        `Step failed: ${stepResults.at(-1)?.output}`,
      );
    }

    return {
      success: allSuccess && verificationPassed !== false,
      mode,
      steps_executed: stepResults,
      verification_passed: verificationPassed,
      escalation_needed: escalationNeeded,
    };
  }

  /**
   * Check if a reading indicates the anomaly has cleared.
   * Simple heuristic: if the reading produced the anomaly before, and doesn't now,
   * the condition has cleared.
   *
   * MED-002: Uses injected classifier (this.deps.classifier) instead of require()
   * which was illegal in ESM context and broke the verification probe path.
   */
  private readingIsClear(reading: SourceReading, anomaly: HealthAnomaly): boolean {
    const anomalies = this.deps.classifier.classify(reading);
    return !anomalies.some(
      (a) => a.anomaly_type === anomaly.anomaly_type && a.target_id === anomaly.target_id,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
