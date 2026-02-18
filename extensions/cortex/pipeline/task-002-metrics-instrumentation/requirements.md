# Requirements Document - Metrics Instrumentation + QA Report Template

**Task ID**: task-002-metrics-instrumentation  
**Version**: 1.0  
**Date**: 2026-02-17  
**Phase**: 1.3  
**Role**: Requirements Analyst

## Summary

Build a tamper-evident metrics collection system for cortex and synapse to ensure honest reporting. The agent cannot be trusted to self-report metrics - instrumented code must write directly to SQLite, and reports query the database directly without agent editorialization.

## Functional Requirements

### FR1: Metrics Database Schema

**Requirement**: Create SQLite database at `~/.openclaw/metrics.db` with 4 tables:

- `cortex_metrics`: timestamp, metric_name, metric_value, context
- `synapse_metrics`: timestamp, from_agent, to_agent, action, thread_id, latency_ms
- `pipeline_metrics`: timestamp, task_id, stage, result, duration_ms
- `sop_events`: timestamp, sop_name, tool_blocked, tool_name, acknowledged

**Acceptance Criteria**: Database schema creates successfully, supports concurrent writes, WAL mode enabled

### FR2: Cortex Instrumentation

**Requirement**: Instrument `extensions/cortex/index.ts` to log metrics via code, not agent reporting

- **SOP Events**: In existing `before_tool_call` hook, write row to `sop_events` every time SOP fires
- **Memory Injection**: In `before_agent_start`, log every memory injection to `cortex_metrics`
- **Storage Method**: Lightweight SQLite writes via better-sqlite3 or Python subprocess spawn

**Acceptance Criteria**: Every SOP block and memory injection generates a database row without agent involvement

### FR3: Synapse Instrumentation

**Requirement**: Instrument synapse operations to log every send/ack/read with timestamps and latency

- Track inter-agent communication patterns
- Measure response times between agents
- Record thread relationships

**Acceptance Criteria**: All synapse operations generate automatic database rows

### FR4: QA Report Template

**Requirement**: Create `~/Projects/helios/extensions/cortex/sop/qa-report-template.md` with:

- Standard sections: Date, Version, Metrics Period, Test Results
- **Raw SQL Queries**: Include actual queries for Matthew to verify
- Example: `sqlite3 ~/.openclaw/metrics.db 'SELECT count(*) FROM sop_events WHERE date(timestamp)=date("now")'`
- Sections: SOP Enforcement, Memory Quality, Synapse Health, Pipeline Performance, Failures & Regressions

**Acceptance Criteria**: Template includes verifiable SQL queries, no agent-editorialized numbers

### FR5: Daily Metrics Aggregation

**Requirement**: Create cron query for nightly summary emails that pull from `metrics.db`

- Replace agent memory-based reporting
- Provide consistent, tamper-proof daily metrics
- Enable automated reporting pipeline

**Acceptance Criteria**: Cron job queries database directly, bypasses agent memory

## Non-Functional Requirements

### NFR1: Tamper-Evident Design

- Metrics collection must be **instrumented in code**, not self-reported
- Agent cannot modify or influence metric values
- Database writes occur in tool hooks, not agent logic
- Raw SQL queries included in reports for verification

### NFR2: Performance

- SQLite writes must be lightweight (< 1ms per write)
- No impact on normal cortex/synapse operations
- Concurrent write safety via WAL mode
- Minimal memory overhead

### NFR3: Reliability

- Database writes must succeed or fail cleanly
- No data loss during high-volume periods
- Recovery mechanisms for database lock contention
- Backward compatibility with existing systems

## Dependencies

### Existing Systems

- **Cortex Extension**: `extensions/cortex/index.ts` (SOP hooks already exist)
- **Synapse System**: Message passing infrastructure
- **Pipeline System**: Task tracking and deployment pipeline
- **Better-SQLite3**: Lightweight SQLite driver (or Python subprocess alternative)

### File Modifications Required

- `extensions/cortex/index.ts`: Add metrics logging to existing hooks
- `extensions/cortex/synapse/*`: Add instrumentation to message operations
- Create: `~/.openclaw/metrics.db` (SQLite database)
- Create: `~/Projects/helios/extensions/cortex/sop/qa-report-template.md`
- Create: Daily cron query script

## Acceptance Criteria

### Primary Success Criteria

1. ✅ **metrics.db created** with 4-table schema and WAL mode enabled
2. ✅ **SOP events logging** - every before_tool_call writes to sop_events table
3. ✅ **Memory injection logging** - every before_agent_start logs memory injection
4. ✅ **Synapse instrumentation** - every send/ack/read writes to synapse_metrics
5. ✅ **QA report template** - includes raw SQL queries for verification
6. ✅ **Daily aggregation query** - cron job queries database directly

### Verification Tests

- SQLite database accepts concurrent writes under load
- SOP enforcement events appear in database in real-time
- Memory injection counts match actual system behavior
- Synapse latency measurements are accurate
- QA report SQL queries execute successfully
- Daily aggregation produces consistent results

## Out of Scope

### Excluded from Task #002

- **Historical data migration**: Start fresh with new metrics system
- **Web dashboard**: Text-based reports sufficient for Phase 1.3
- **Real-time alerts**: Daily aggregation meets current needs
- **Metrics API**: Direct database access sufficient
- **Data retention policies**: Will address in future phases
- **Cross-system metrics**: Focus on cortex/synapse only

### Future Enhancements (Post-1.3)

- Grafana dashboard integration
- Real-time metric streaming
- Historical trend analysis
- Performance optimization metrics
- Cross-agent communication analysis

## Risk Assessment

### High Risk

- **Database locking**: Concurrent writes may cause contention
  - _Mitigation_: WAL mode, lightweight writes, retry logic
- **Performance impact**: Metrics collection could slow operations
  - _Mitigation_: Asynchronous writes, minimal data collection

### Medium Risk

- **Storage growth**: Metrics database may grow large over time
  - _Mitigation_: Daily aggregation, future retention policies
- **Schema changes**: Adding metrics columns may require migrations
  - _Mitigation_: Version schema, plan for backwards compatibility

### Low Risk

- **Tool integration**: better-sqlite3 dependency conflicts
  - _Mitigation_: Python subprocess fallback option available
