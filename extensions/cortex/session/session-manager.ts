/**
 * Session Persistence Manager — Cross-Session State Preservation
 * Cortex v2.0.0
 *
 * Orchestrates session capture, restoration, crash recovery, and pin inheritance.
 */

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CortexBridge } from "../cortex-bridge.js";
import type {
  PendingTask,
  RestoredSessionContext,
  SessionPersistenceConfig,
  SessionState,
  WorkingMemoryPin,
} from "./types.js";
import { calculateRelevanceScore } from "./context-scorer.js";
import { PreambleInjector } from "./preamble-injector.js";

/** Credential patterns to redact from stored pin content */
const CREDENTIAL_PATTERNS = [
  /\b(password|passwd|secret|api[_-]?key|token|auth|bearer|private[_-]?key)\s*[:=]\s*\S+/gi,
  /sk-[a-zA-Z0-9]{32,}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xoxb-[a-zA-Z0-9-]+/g,
];

function redactCredentials(content: string): string {
  let redacted = content;
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

interface Logger {
  info: ((message: string) => void) | undefined;
  warn: ((message: string) => void) | undefined;
  debug?: (message: string) => void;
}

export class SessionPersistenceManager {
  private bridge: CortexBridge;
  private logger: Logger;
  private config: SessionPersistenceConfig;
  private preambleInjector: PreambleInjector;
  private currentSessionId: string | null = null;
  private currentState: Record<string, unknown> = {};

  constructor(bridge: CortexBridge, logger: Logger, config: SessionPersistenceConfig) {
    this.bridge = bridge;
    this.logger = logger;
    this.config = config;
    this.preambleInjector = new PreambleInjector();
  }

  /**
   * Called from registerService.start() — restore prior session context.
   */
  async onSessionStart(
    sessionId: string,
    channel: string,
    loadWorkingMemory: () => Promise<WorkingMemoryPin[]>,
    saveWorkingMemory: (items: WorkingMemoryPin[]) => Promise<void>,
  ): Promise<RestoredSessionContext> {
    this.currentSessionId = sessionId;

    const emptyResult: RestoredSessionContext = {
      preamble: null,
      inheritedPins: [],
      sessionIds: [],
      relevanceScores: [],
      pendingTaskCount: 0,
    };

    try {
      // Detect and recover crashed sessions
      await this.detectAndRecoverCrashed(sessionId);

      // Write initial session record (no end_time = active)
      const now = new Date().toISOString();
      this.currentState = {
        session_id: sessionId,
        start_time: now,
        end_time: null,
        channel,
        working_memory: [],
        hot_topics: [],
        active_projects: [],
        pending_tasks: [],
        recent_learnings: [],
        confidence_updates: [],
        sop_interactions: [],
        previous_session_id: null,
        continued_by: null,
        crash_recovered: false,
        schema_version: 1,
        created_at: now,
        updated_at: now,
      };
      await this.bridge.saveSessionState(this.currentState as Record<string, unknown>);

      // Fetch recent completed sessions
      const recentRaw = await this.bridge.getRecentSessions(
        this.config.lookback_days,
        this.config.max_sessions_scored * 3,
      );

      if (recentRaw.length === 0) {
        this.logger.debug?.("Session persistence: cold start (no prior sessions)");
        return emptyResult;
      }

      // Get current working memory for keyword context
      const currentPins = await loadWorkingMemory();
      const currentKeywords = currentPins.map((p) => p.label ?? "").filter((l) => l.length > 0);

      // Score sessions
      const scored: SessionState[] = [];
      for (const raw of recentRaw) {
        const session = raw as unknown as SessionState;
        if (!session.end_time) continue;

        const hoursElapsed = (Date.now() - new Date(session.end_time).getTime()) / (1000 * 60 * 60);
        const score = calculateRelevanceScore(session, currentKeywords, hoursElapsed);

        if (score >= this.config.relevance_threshold) {
          session.relevance_score = score;
          scored.push(session);
        }
      }

      scored.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
      const topSessions = scored.slice(0, this.config.max_sessions_scored);

      if (topSessions.length === 0) {
        this.logger.debug?.("Session persistence: no qualifying prior sessions");
        return emptyResult;
      }

      // Inherit pins from highest-scoring session
      const bestSession = topSessions[0];
      const inheritedPins: WorkingMemoryPin[] = [];

      if (bestSession.working_memory && bestSession.working_memory.length > 0) {
        const maxInherit = this.config.max_inherited_pins;
        const existingLabels = new Set(currentPins.map((p) => p.label));
        const availableSlots = 10 - currentPins.length;
        const maxToInherit = Math.min(maxInherit, availableSlots);

        for (const pin of bestSession.working_memory.slice(0, maxToInherit)) {
          if (pin.label && existingLabels.has(pin.label)) continue;
          inheritedPins.push({
            content: pin.content,
            pinnedAt: new Date().toISOString(),
            label: pin.label,
          });
        }

        if (inheritedPins.length > 0) {
          const updated = [...currentPins, ...inheritedPins];
          await saveWorkingMemory(updated);
        }
      }

      // Link this session to the best prior session
      this.currentState.previous_session_id = bestSession.session_id;
      await this.bridge.saveSessionState(this.currentState as Record<string, unknown>);

      // Mark prior sessions as continued
      for (const s of topSessions) {
        try {
          await this.bridge.markSessionContinued(s.session_id, sessionId);
        } catch {
          // Non-fatal
        }
      }

      const preamble = this.preambleInjector.format(topSessions, inheritedPins.length);

      let pendingTaskCount = 0;
      for (const s of topSessions) {
        pendingTaskCount += s.pending_tasks.length;
      }

      this.logger.info?.(
        `Session persistence: restored from ${topSessions.length} session(s), ` +
          `${inheritedPins.length} pins inherited, ${pendingTaskCount} pending tasks`,
      );

      return {
        preamble,
        inheritedPins,
        sessionIds: topSessions.map((s) => s.session_id),
        relevanceScores: topSessions.map((s) => s.relevance_score ?? 0),
        pendingTaskCount,
      };
    } catch (err) {
      this.logger.warn?.(`Session persistence restoration failed (cold start): ${err}`);
      return emptyResult;
    }
  }

  /**
   * Called from agent_end hook — incremental crash-safe state update.
   */
  async updateSessionState(partial: Record<string, unknown>): Promise<void> {
    if (!this.currentSessionId) return;

    try {
      Object.assign(this.currentState, partial, {
        updated_at: new Date().toISOString(),
      });
      await this.bridge.saveSessionState(this.currentState as Record<string, unknown>);
    } catch (err) {
      this.logger.debug?.(`Session persistence incremental update failed: ${err}`);
    }
  }

  /**
   * Called from registerService.stop() — final session capture.
   */
  async onSessionEnd(
    sessionId: string,
    hotTopics: string[],
    activeProjects: string[],
    pendingTasks: PendingTask[],
    learningIds: string[],
    sopInteractions: SessionState["sop_interactions"],
    loadWorkingMemory: () => Promise<WorkingMemoryPin[]>,
  ): Promise<void> {
    try {
      const currentPins = await loadWorkingMemory();
      const redactedPins = currentPins.map((p) => ({
        ...p,
        content: redactCredentials(p.content),
      }));

      const now = new Date().toISOString();
      const finalState: Record<string, unknown> = {
        ...this.currentState,
        session_id: sessionId,
        end_time: now,
        working_memory: redactedPins,
        hot_topics: hotTopics,
        active_projects: activeProjects,
        pending_tasks: pendingTasks,
        recent_learnings: learningIds,
        sop_interactions: sopInteractions,
        updated_at: now,
      };

      await this.bridge.saveSessionState(finalState);

      // Write JSON mirror
      const sessionsDir = this.config.sessions_dir.replace(/^~/, homedir());
      try {
        if (!existsSync(sessionsDir)) {
          mkdirSync(sessionsDir, { recursive: true });
        }
        await writeFile(
          join(sessionsDir, `${sessionId}.json`),
          JSON.stringify(finalState, null, 2),
        );
      } catch {
        // JSON mirror is best-effort
      }

      this.logger.info?.(
        `Session ${sessionId} captured: ${redactedPins.length} pins, ` +
          `${hotTopics.length} topics, ${pendingTasks.length} tasks`,
      );
    } catch (err) {
      this.logger.warn?.(`Session capture failed: ${err}`);
    }
  }

  /**
   * Detect and recover crashed sessions (NULL end_time).
   */
  async detectAndRecoverCrashed(currentSessionId: string): Promise<void> {
    try {
      const crashed = await this.bridge.detectCrashedSessions(currentSessionId);
      const now = new Date().toISOString();

      for (const session of crashed) {
        const sid = (session as Record<string, unknown>).session_id as string;
        try {
          await this.bridge.recoverCrashedSession(sid, now);
          this.logger.info?.(`Recovered crashed session: ${sid}`);
        } catch {
          // Non-fatal
        }
      }

      if (crashed.length > 0) {
        this.logger.info?.(`Recovered ${crashed.length} crashed session(s)`);
      }
    } catch (err) {
      this.logger.debug?.(`Crash detection failed: ${err}`);
    }
  }

  /**
   * Manual override: force-inherit from a specific prior session.
   */
  async forceInheritSession(
    targetSessionId: string,
    loadWorkingMemory: () => Promise<WorkingMemoryPin[]>,
    saveWorkingMemory: (items: WorkingMemoryPin[]) => Promise<void>,
  ): Promise<RestoredSessionContext> {
    const chain = await this.bridge.getSessionChain(targetSessionId, 1);
    if (chain.length === 0) {
      return {
        preamble: null,
        inheritedPins: [],
        sessionIds: [],
        relevanceScores: [],
        pendingTaskCount: 0,
      };
    }

    const session = chain[0] as unknown as SessionState;
    session.relevance_score = 1.0;

    const currentPins = await loadWorkingMemory();
    const inheritedPins: WorkingMemoryPin[] = [];
    const existingLabels = new Set(currentPins.map((p) => p.label));
    const availableSlots = 10 - currentPins.length;
    const maxToInherit = Math.min(this.config.max_inherited_pins, availableSlots);

    if (session.working_memory) {
      for (const pin of session.working_memory.slice(0, maxToInherit)) {
        if (pin.label && existingLabels.has(pin.label)) continue;
        inheritedPins.push({
          content: pin.content,
          pinnedAt: new Date().toISOString(),
          label: pin.label,
        });
      }

      if (inheritedPins.length > 0) {
        await saveWorkingMemory([...currentPins, ...inheritedPins]);
      }
    }

    const preamble = this.preambleInjector.format([session], inheritedPins.length);

    return {
      preamble,
      inheritedPins,
      sessionIds: [session.session_id],
      relevanceScores: [1.0],
      pendingTaskCount: session.pending_tasks.length,
    };
  }

  /**
   * Get session chain for debugging/analysis.
   */
  async getSessionChain(sessionId: string, depth: number = 5): Promise<SessionState[]> {
    const chain = await this.bridge.getSessionChain(sessionId, depth);
    return chain as unknown as SessionState[];
  }
}
