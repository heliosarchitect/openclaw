/**
 * Real-Time Learning Engine — Main Orchestrator
 * Cortex v2.6.0 (task-011, Phase 5.7)
 *
 * Reactive event pipeline: detect failures → classify root cause → propagate fixes.
 * Three layers: Detection → Classification → Propagation, all async and non-blocking.
 *
 * Integration points:
 * - Tool errors (after_tool_call hook)
 * - User corrections (session message scan)
 * - SOP violations (task-003 hooks)
 * - Trust demotions (task-010 earned autonomy)
 * - Pipeline failures (orchestrator)
 */

import type {
  DetectionPayload,
  FailureEvent,
  PropagationTarget,
  RealtimeLearningConfig,
  RealtimeLearningDeps,
} from "./types.js";
import { AsyncQueue } from "./async-queue.js";
import { FailureClassifier } from "./classification/failure-classifier.js";
import { CorrectionScanner } from "./detection/correction-scanner.js";
import { HookViolationRelay } from "./detection/hook-violation-relay.js";
import { PipelineFailRelay } from "./detection/pipeline-fail-relay.js";
import { ToolMonitor } from "./detection/tool-monitor.js";
import { TrustEventRelay } from "./detection/trust-event-relay.js";
import { MetricsEmitter } from "./metrics/metrics-emitter.js";
import { AtomPropagator } from "./propagation/atom-propagator.js";
import { CrossSystemRelay } from "./propagation/cross-system-relay.js";
import { RegressionTestGen } from "./propagation/regression-test-gen.js";
import { SOPPatcher } from "./propagation/sop-patcher.js";
import { RecurrenceDetector } from "./recurrence/recurrence-detector.js";
import { runRealtimeLearningMigrations } from "./schema.js";

export type { RealtimeLearningConfig, RealtimeLearningDeps } from "./types.js";
export { DEFAULT_REALTIME_LEARNING_CONFIG } from "./types.js";

export class RealtimeLearningEngine {
  // Detection layer
  private detectionQueue: AsyncQueue<DetectionPayload>;
  readonly toolMonitor: ToolMonitor;
  readonly correctionScanner: CorrectionScanner;
  readonly hookViolationRelay: HookViolationRelay;
  readonly trustEventRelay: TrustEventRelay;
  readonly pipelineFailRelay: PipelineFailRelay;

  // Classification layer
  private classifier: FailureClassifier;

  // Propagation layer
  private sopPatcher: SOPPatcher;
  private atomPropagator: AtomPropagator;
  private regressionTestGen: RegressionTestGen;
  private crossSystemRelay: CrossSystemRelay;
  private recurrenceDetector: RecurrenceDetector;

  // Metrics
  readonly metrics: MetricsEmitter;

  // State
  private config: RealtimeLearningConfig;
  private deps: RealtimeLearningDeps;
  private started = false;
  private processedCount = 0;

  constructor(config: RealtimeLearningConfig, deps: RealtimeLearningDeps) {
    this.config = config;
    this.deps = deps;

    // Detection layer
    this.detectionQueue = new AsyncQueue<DetectionPayload>(deps.logger);
    this.detectionQueue.onDrain((payload) => this.processDetection(payload));

    this.toolMonitor = new ToolMonitor(this.detectionQueue, deps.logger);
    this.correctionScanner = new CorrectionScanner(this.detectionQueue, config, deps.logger);
    this.hookViolationRelay = new HookViolationRelay(this.detectionQueue);
    this.trustEventRelay = new TrustEventRelay(this.detectionQueue);
    this.pipelineFailRelay = new PipelineFailRelay(this.detectionQueue);

    // Classification
    this.classifier = new FailureClassifier();

    // Propagation
    this.sopPatcher = new SOPPatcher(config, deps);
    this.atomPropagator = new AtomPropagator(deps.db, deps.logger);
    this.regressionTestGen = new RegressionTestGen(deps.db, deps.repoRoot, deps.logger);
    this.crossSystemRelay = new CrossSystemRelay(deps);
    this.recurrenceDetector = new RecurrenceDetector(config, deps);

    // Metrics
    this.metrics = new MetricsEmitter(deps.db);
  }

  /**
   * Initialize DB tables and mark engine as started.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await runRealtimeLearningMigrations(this.deps.db);
    this.started = true;
    this.deps.logger?.info?.("[RTL] Real-Time Learning engine started (Phase 5.7)");
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get stats(): { processed: number; pending: number } {
    return {
      processed: this.processedCount,
      pending: this.detectionQueue.pending,
    };
  }

  // ─── Core pipeline ───

  private async processDetection(payload: DetectionPayload): Promise<void> {
    if (!this.started) return;

    const startMs = Date.now();

    try {
      // Step 1: Classify
      const classification = this.classifier.classify(payload);

      // Step 2: Persist failure event
      const failureId = this.generateId();
      const failure: FailureEvent = {
        id: failureId,
        detected_at: new Date().toISOString(),
        type: payload.type,
        tier: payload.tier,
        source: payload.source,
        context: payload.context,
        raw_input: payload.raw_input,
        failure_desc: payload.failure_desc,
        root_cause: classification.root_cause,
        propagation_status: "pending",
        recurrence_count: 0,
      };

      await this.deps.db.run(
        `INSERT INTO failure_events (id, detected_at, type, tier, source, context, raw_input, failure_desc, root_cause, propagation_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          failure.id,
          failure.detected_at,
          failure.type,
          failure.tier,
          failure.source,
          JSON.stringify(failure.context),
          failure.raw_input ?? null,
          failure.failure_desc,
          failure.root_cause ?? null,
          failure.propagation_status,
        ],
      );

      // Step 3: Propagate to all targets
      await this.deps.db.run(
        "UPDATE failure_events SET propagation_status = 'in_progress' WHERE id = ?",
        [failure.id],
      );

      let anyCommitted = false;
      for (const target of classification.propagation_targets) {
        const result = await this.propagateToTarget(
          failure,
          target,
          classification.propagation_targets,
        );
        if (result) anyCommitted = true;
      }

      // Step 4: Update propagation status
      await this.deps.db.run(`UPDATE failure_events SET propagation_status = ? WHERE id = ?`, [
        anyCommitted ? "propagated" : "escalated",
        failure.id,
      ]);

      // Step 5: Check recurrence
      await this.recurrenceDetector.check(failure);

      // Step 6: Emit metrics
      const durationMs = Date.now() - startMs;
      await this.deps.writeMetric("pipeline", {
        task_id: "rtl_failure_processed",
        stage: failure.type,
        result: anyCommitted ? "propagated" : "escalated",
        duration_ms: durationMs,
      });

      this.processedCount++;
      this.deps.logger?.info?.(
        `[RTL] Processed ${failure.type}:${failure.root_cause} in ${durationMs}ms → ${anyCommitted ? "propagated" : "escalated"}`,
      );
    } catch (err) {
      this.deps.logger?.warn?.(`[RTL] Detection processing failed: ${err}`);
    }
  }

  private async propagateToTarget(
    failure: FailureEvent,
    target: PropagationTarget,
    allTargets: PropagationTarget[],
  ): Promise<boolean> {
    const propId = this.generateId();
    const startedAt = new Date().toISOString();

    try {
      await this.deps.db.run(
        `INSERT INTO propagation_records (id, failure_id, started_at, propagation_type, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [propId, failure.id, startedAt, target],
      );

      let status: "committed" | "previewed" | "failed" = "failed";
      let targetFile: string | undefined;
      let commitSha: string | undefined;
      let synapseMsgId: string | undefined;

      switch (target) {
        case "sop_patch": {
          const result = await this.sopPatcher.patch(failure);
          status = result.status === "skipped" ? "failed" : result.status;
          targetFile = result.target_file;
          commitSha = result.commit_sha;
          synapseMsgId = result.synapse_msg_id;
          break;
        }

        case "hook_pattern": {
          // Hook patterns are append-only — record the event for manual hook update
          await this.deps.sendSynapse(
            `Hook pattern update needed: ${failure.root_cause}`,
            `Failure ${failure.id} (${failure.type}) suggests adding a hook pattern for: ${failure.failure_desc}`,
            "info",
            `rtl:hook:${failure.id}`,
          );
          status = "committed";
          break;
        }

        case "atom": {
          const result = await this.atomPropagator.propagate(failure, allTargets);
          status = result.success ? "committed" : "failed";
          break;
        }

        case "regression_test": {
          const result = await this.regressionTestGen.generate(failure);
          status = "committed";
          targetFile = result.test_file;
          break;
        }

        case "synapse_relay": {
          synapseMsgId = await this.deps.sendSynapse(
            `Failure alert: ${failure.type} — ${failure.root_cause}`,
            `**Failure:** ${failure.failure_desc}\n**Source:** ${failure.source}\n**Root cause:** ${failure.root_cause ?? "unknown"}\n**Tier:** ${failure.tier}`,
            failure.tier >= 3 ? "urgent" : "action",
            `rtl:${failure.id}`,
          );
          status = "committed";
          break;
        }

        case "cross_system": {
          synapseMsgId = await this.crossSystemRelay.relay(failure);
          status = "committed";
          break;
        }
      }

      const completedAt = new Date().toISOString();
      await this.deps.db.run(
        `UPDATE propagation_records
         SET status = ?, completed_at = ?, target_file = ?, commit_sha = ?, synapse_msg_id = ?
         WHERE id = ?`,
        [status, completedAt, targetFile ?? null, commitSha ?? null, synapseMsgId ?? null, propId],
      );

      return status === "committed";
    } catch (err) {
      await this.deps.db.run(
        `UPDATE propagation_records SET status = 'failed', error_detail = ? WHERE id = ?`,
        [`${err}`, propId],
      );
      return false;
    }
  }

  // ─── Public API (for cortex_learn tool) ───

  /**
   * Get recent failure events.
   */
  async getFailures(opts?: {
    days?: number;
    type?: string;
    status?: string;
    limit?: number;
  }): Promise<FailureEvent[]> {
    const days = opts?.days ?? 7;
    const limit = opts?.limit ?? 50;
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

    let sql = `SELECT * FROM failure_events WHERE detected_at > ?`;
    const params: unknown[] = [cutoff];

    if (opts?.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    if (opts?.status) {
      sql += ` AND propagation_status = ?`;
      params.push(opts.status);
    }

    sql += ` ORDER BY detected_at DESC LIMIT ?`;
    params.push(limit);

    const rows = await this.deps.db.all<FailureEvent>(sql, params);
    return rows.map((r) => ({
      ...r,
      context: typeof r.context === "string" ? JSON.parse(r.context as string) : r.context,
    }));
  }

  /**
   * Get failure details with propagation records.
   */
  async getFailureDetail(failureId: string): Promise<{
    failure: FailureEvent | null;
    propagations: Array<Record<string, unknown>>;
    regression_tests: Array<Record<string, unknown>>;
  }> {
    const failure = await this.deps.db.get<FailureEvent>(
      "SELECT * FROM failure_events WHERE id = ?",
      [failureId],
    );

    const propagations = await this.deps.db.all(
      "SELECT * FROM propagation_records WHERE failure_id = ? ORDER BY started_at",
      [failureId],
    );

    const tests = await this.deps.db.all("SELECT * FROM regression_tests WHERE failure_id = ?", [
      failureId,
    ]);

    return {
      failure: failure
        ? {
            ...failure,
            context:
              typeof failure.context === "string"
                ? JSON.parse(failure.context as string)
                : failure.context,
          }
        : null,
      propagations,
      regression_tests: tests,
    };
  }

  // ─── Utilities ───

  private generateId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
