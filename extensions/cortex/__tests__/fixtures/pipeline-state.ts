/**
 * Pipeline state factory for tests
 */
export function createPipelineState(overrides?: Record<string, unknown>) {
  return {
    pipeline_version: "1.0.0",
    active_tasks: [],
    completed_tasks: [],
    queued_tasks: [],
    status: "running",
    next_task_id: 1,
    ...overrides,
  };
}

export function createActiveTask(overrides?: Record<string, unknown>) {
  return {
    task_id: "task-test-001",
    title: "Test Task",
    phase: "1.0",
    status: "active",
    current_stage: "build",
    stages_completed: ["requirements", "design"],
    artifacts: {},
    ...overrides,
  };
}
