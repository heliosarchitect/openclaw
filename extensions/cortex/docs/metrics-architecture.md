# Metrics System Architecture - Tamper-Evident Design

**Version**: 1.0  
**Date**: 2026-02-17  
**Component**: Cortex Extension  
**Phase**: 1.3

## Overview

The Cortex Metrics System implements a **tamper-evident metrics collection architecture** where metrics are written by instrumented code, not self-reported by agents. This ensures honest and verifiable metrics for quality assurance and system monitoring.

## Core Principle

```
AGENTS CANNOT LIE ABOUT METRICS BECAUSE AGENTS DON'T WRITE METRICS
```

**Design Philosophy**:

- **Code writes metrics** (via instrumented hooks)
- **Reports query metrics** (via raw SQL)
- **Agents never touch the data** (no self-reporting bias)

## Architecture Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Tool Hooks    │    │  MetricsWriter   │    │   metrics.db    │
│  (Instrumented  │───▶│   (Python)       │───▶│    (SQLite)     │
│     Code)       │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         ▲                       ▲                        │
         │                       │                        │
         │              ┌──────────────────┐              │
         │              │ Connection Pool  │              │
         │              │ + Retry Logic    │              │
         │              └──────────────────┘              │
         │                                                 ▼
┌─────────────────┐                              ┌─────────────────┐
│ before_tool_call│                              │  QA Reports     │
│before_agent_start│                             │  (Raw SQL)      │
│ synapse_send/ack│                              │                 │
└─────────────────┘                              └─────────────────┘
```

## Database Schema

### Tables Overview

```sql
metrics.db (SQLite + WAL mode)
├── cortex_metrics     (Memory injection, confidence scoring)
├── synapse_metrics    (Inter-agent communication)
├── pipeline_metrics   (Development pipeline performance)
└── sop_events         (Standard operating procedure enforcement)
```

### Schema Definitions

```sql
CREATE TABLE cortex_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- ISO 8601 format
    metric_name TEXT NOT NULL,         -- 'memory_injected', 'confidence_score'
    metric_value REAL NOT NULL,        -- Numeric metric value
    context TEXT,                      -- 'tier_stm_trading', 'sop_block_fired'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE synapse_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- Message timestamp
    from_agent TEXT NOT NULL,          -- Sender agent ID
    to_agent TEXT NOT NULL,            -- Recipient agent ID
    action TEXT NOT NULL,              -- 'send', 'ack', 'read'
    thread_id TEXT,                    -- Thread relationship
    latency_ms REAL,                   -- Response latency measurement
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pipeline_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- Stage completion time
    task_id TEXT NOT NULL,             -- 'task-002-metrics-instrumentation'
    stage TEXT NOT NULL,               -- 'requirements', 'design', 'build'
    result TEXT NOT NULL,              -- 'pass', 'fail', 'block'
    duration_ms REAL,                  -- Stage execution time
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- SOP enforcement timestamp
    sop_name TEXT NOT NULL,            -- 'comfyui.ai.sop', 'ft991a.ai.sop'
    tool_blocked BOOLEAN NOT NULL,     -- Whether tool was blocked
    tool_name TEXT,                    -- Blocked tool name
    acknowledged BOOLEAN DEFAULT FALSE,-- Whether block was acknowledged
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Integration Points

### 1. Cortex Extension Hooks

#### before_tool_call Hook (SOP Enforcement)

**File**: `extensions/cortex/index.ts:~2478`  
**Triggers**: Every tool call evaluation

```typescript
// Inside before_tool_call handler
const metricsWriter = await import("./python/metrics_writer.py");
await metricsWriter.writeSopEvent({
  timestamp: new Date().toISOString(),
  sop_name: sopFileName,
  tool_blocked: wasBlocked,
  tool_name: toolName,
  acknowledged: false,
});
```

#### before_agent_start Hook (Memory Injection)

**File**: `extensions/cortex/index.ts:~1841`  
**Triggers**: Every agent run start

```typescript
// Inside memory injection logic
await metricsWriter.writeCortexMetric({
  timestamp: new Date().toISOString(),
  metric_name: "memory_injected",
  metric_value: injectedMemoryCount,
  context: `tier_${tierName}_${category}`,
});
```

### 2. Synapse System Hooks

#### Message Operations

**Files**: `extensions/cortex/cortex-bridge.ts` (synapse methods)
**Triggers**: send/ack/read operations

```typescript
// In synapseSend()
const startTime = performance.now();
// ... send logic ...
const endTime = performance.now();

await metricsWriter.writeSynapseMetric({
  timestamp: new Date().toISOString(),
  from_agent: fromAgent,
  to_agent: toAgent,
  action: "send",
  thread_id: threadId,
  latency_ms: endTime - startTime,
});
```

### 3. Pipeline System Hooks

#### Stage Completion Tracking

**File**: Pipeline orchestrator  
**Triggers**: Stage start/completion events

```typescript
// At stage completion
await metricsWriter.writePipelineMetric({
  timestamp: new Date().toISOString(),
  task_id: currentTaskId,
  stage: stageName,
  result: stageResult, // 'pass', 'fail', 'block'
  duration_ms: stageEndTime - stageStartTime,
});
```

## Tamper-Evident Properties

### 1. Code-Driven Collection

- **Metrics written by instrumented code**, not agent logic
- **Hooks fire automatically** during normal operations
- **No agent decision-making** in metric collection process

### 2. Immutable Storage

- **SQLite database** provides ACID guarantees
- **WAL mode** enables concurrent access without corruption
- **Timestamps** provide chronological integrity

### 3. Verifiable Queries

- **Raw SQL queries** in QA reports enable independent verification
- **No agent interpretation** of data - Matthew can run queries directly
- **Query results** are the single source of truth

### 4. Audit Trail

- **Every metric** traceable to specific code instrumentation point
- **Database changes** logged via SQLite's built-in journaling
- **Backup snapshots** enable historical verification

## Performance Characteristics

### Write Performance

- **Target latency**: < 1ms per metric write (99th percentile)
- **Async operations**: Non-blocking metric collection
- **Connection pooling**: Reuse database connections
- **Batch writes**: Group high-frequency events

### Storage Efficiency

- **SQLite storage**: ~10KB per 1000 metrics
- **Index strategy**: Timestamp-based for query performance
- **Compression**: WAL mode enables efficient storage

### Concurrency Handling

- **WAL mode**: Concurrent reads during writes
- **Retry logic**: Handle database lock contention
- **Connection limits**: Max 5 concurrent writers

## Monitoring & Alerting

### Health Checks

```sql
-- Verify metrics collection is active
SELECT COUNT(*) FROM cortex_metrics
WHERE datetime(timestamp) >= datetime('now', '-1 hour');

-- Check for database issues
PRAGMA integrity_check;
PRAGMA optimize;
```

### Alert Conditions

- **No metrics written** in 4+ hours during operation
- **Database size growth** > 10MB/day sustained
- **Query performance** degradation (>100ms for standard queries)
- **SOP instrumentation failure** (no sop_events for 2+ hours)

## Security Considerations

### Database Security

- **File permissions**: 0640 (owner read/write, group read)
- **Backup permissions**: 0600 (owner only)
- **Process isolation**: Only gateway process writes metrics

### Data Integrity

- **Schema validation**: Strict data types and constraints
- **Timestamp consistency**: ISO 8601 format enforced
- **Foreign key constraints**: Maintain referential integrity

### Access Control

- **Read access**: QA reports and maintenance scripts only
- **Write access**: Instrumented code hooks only
- **No agent access**: Agents cannot query or modify metrics

## Maintenance Procedures

### Daily Tasks

```bash
# Database optimization
sqlite3 ~/.openclaw/metrics.db "PRAGMA optimize; VACUUM;"

# Backup creation
cp ~/.openclaw/metrics.db ~/.openclaw/backups/metrics-$(date +%Y%m%d).db

# Health check
sqlite3 ~/.openclaw/metrics.db "PRAGMA integrity_check;"
```

### Weekly Tasks

```bash
# Size monitoring
du -h ~/.openclaw/metrics.db

# Performance analysis
sqlite3 ~/.openclaw/metrics.db ".timer on" "SELECT COUNT(*) FROM cortex_metrics WHERE date(timestamp) >= date('now', '-7 days');"
```

## Future Enhancements

### Phase 1.4 (Next)

- **Data retention policies**: Automatic old data cleanup
- **Additional instrumentation**: Tool execution timing, error rates
- **Enhanced indexing**: Query performance optimization

### Phase 2.0 (Future)

- **Real-time dashboards**: Grafana integration
- **Stream processing**: Real-time metric analysis
- **Cross-system metrics**: Integration with other LBF systems
- **Machine learning**: Anomaly detection on metric patterns

## Migration Strategy

### From Legacy Systems

- **Clean start**: No migration from existing ad-hoc metrics
- **Parallel operation**: Legacy and new systems run concurrently initially
- **Gradual adoption**: Replace legacy metrics with instrumented versions

### Schema Evolution

- **Version metadata**: Track schema version in database
- **Backward compatibility**: Additive changes only in minor versions
- **Migration scripts**: Automated schema updates for major versions

## Testing Strategy

### Unit Tests

- **MetricsWriter class**: Database operations, retry logic
- **Hook integration**: Verify metrics written on trigger events
- **Query validation**: Ensure QA report queries execute successfully

### Integration Tests

- **End-to-end flow**: Tool call → metric write → query result
- **Concurrency testing**: Multiple writers, database locking
- **Performance testing**: Write latency under load

### Acceptance Tests

- **SOP enforcement tracking**: Verify blocks are recorded
- **Memory injection logging**: Confirm injection counts
- **Synapse communication**: Validate message tracking
- **QA report generation**: Ensure reports contain valid data

This architecture ensures honest, verifiable metrics collection while maintaining system performance and providing comprehensive quality assurance capabilities.
