# Requirements — task-018-memory-consolidation

## Summary

Build a deterministic memory consolidation system for Cortex that continuously reduces duplicate/redundant memories, promotes high-value validated knowledge, archives low-utility noise, and flags contradictions for review. The system must run safely against the brain.db-backed memory store without data loss.

## Functional Requirements

1. Define configurable consolidation rules supporting triggers (`daily`, `weekly`, `on_similarity`, `on_contradiction`), conditions, and actions (`merge`, `promote`, `archive`, `flag_contradiction`).
2. Implement duplicate/near-duplicate detection with threshold-based similarity matching.
3. Implement merge behavior that preserves newest canonical content while retaining audit metadata (source IDs, counts, timestamps).
4. Implement promotion behavior for high-confidence, frequently-validated procedural memories.
5. Implement archival behavior for low-utility memories using age/access/confidence heuristics.
6. Implement contradiction detection and flagging for semantically similar but conflicting instructions.
7. Provide dry-run mode with a machine-readable report of proposed actions.
8. Provide execution mode applying approved actions with rollback-safe transaction boundaries.
9. Expose observable logs/metrics for actions taken, skipped, and errors.
10. Integrate with existing cron/maintenance workflows for scheduled execution.

## Non-Functional Requirements

- Safety: no destructive change without explicit execution mode (default dry-run).
- Reliability: transactional writes and idempotent behavior where feasible.
- Performance: consolidation pass over current STM volume completes within acceptable maintenance window.
- Compatibility: works with current `brain.db` schema and Cortex bridge APIs.
- Auditability: every action includes before/after references and rationale.

## Dependencies

- Existing Cortex memory bridge and STM APIs.
- Existing dedupe/compression/reporting patterns and maintenance scripts.
- Cron scheduling integration for periodic runs.

## Acceptance Criteria

- Dry-run produces valid structured report with action counts and sample records.
- Execution mode successfully applies merges/promotions/archives on test data and passes regression checks.
- No TypeScript build regressions (`npx tsc --noEmit` clean).
- Contradictions are flagged with traceable links to conflicting memories.
- Scheduled run can execute end-to-end and emit summary status.

## Out of Scope

- Full long-term memory tiering implementation (Phase 2.3).
- UI/dashboard for manual triage (CLI/report-based workflow only in this task).
