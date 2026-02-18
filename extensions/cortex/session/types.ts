/**
 * Cross-Session State Preservation — Type Definitions
 * Cortex v2.0.0 | Phase 2.1
 */

export interface WorkingMemoryPin {
  content: string;
  pinnedAt: string;
  label?: string;
}

export interface PendingTask {
  task_id: string;
  title: string;
  stage: string;
  flagged_incomplete: boolean;
}

export interface ConfidenceUpdate {
  memory_id: string;
  old_score: number;
  new_score: number;
  reason: string;
  timestamp: string;
}

export interface SOPInteraction {
  sop_path: string;
  injected_at: string;
  acknowledged: boolean;
  tool_call: string;
}

export interface SessionState {
  session_id: string;
  start_time: string;
  end_time: string;
  channel: string;

  // Active context
  working_memory: WorkingMemoryPin[];
  hot_topics: string[];
  active_projects: string[];
  pending_tasks: PendingTask[];

  // Knowledge state
  recent_learnings: string[];
  confidence_updates: ConfidenceUpdate[];
  sop_interactions: SOPInteraction[];

  // Session chain
  previous_session_id: string | null;
  continued_by: string | null;

  // Recovery metadata
  crash_recovered?: boolean;
  schema_version: number;

  // Computed at restore time — NOT stored in DB
  relevance_score?: number;
  inherited_at?: string;
}

export interface RestoredSessionContext {
  preamble: string | null;
  inheritedPins: WorkingMemoryPin[];
  sessionIds: string[];
  relevanceScores: number[];
  pendingTaskCount: number;
}

export interface SessionPersistenceConfig {
  enabled: boolean;
  lookback_days: number;
  relevance_threshold: number;
  max_sessions_scored: number;
  max_inherited_pins: number;
  decay_min_floor: number;
  critical_inheritance_days: number;
  sessions_dir: string;
  debug: boolean;
}

export const DEFAULT_SESSION_CONFIG: SessionPersistenceConfig = {
  enabled: true,
  lookback_days: 7,
  relevance_threshold: 0.25,
  max_sessions_scored: 3,
  max_inherited_pins: 5,
  decay_min_floor: 0.3,
  critical_inheritance_days: 7,
  sessions_dir: "~/.openclaw/sessions",
  debug: false,
};
