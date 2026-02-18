# Technical Design - Metrics Instrumentation + QA Report Template

**Task ID**: task-002-metrics-instrumentation  
**Version**: 1.0  
**Date**: 2026-02-17  
**Role**: Software Architect  
**Input**: requirements.md

## Approach Summary

Implement a **tamper-evident metrics collection system** using SQLite as the single source of truth. The key architectural principle: **instrumented code writes metrics, reports query metrics, agents never touch the data**. This prevents self-reporting bias and ensures honest metrics.

**Core Design Pattern**:

```
Tool Hook → SQLite Write → SQL Query → Report
    ↑            ↑           ↑          ↑
(Instrumented) (Tamper-   (Verifiable)(Human
    Code)     Resistant)   Queries)  Readable)
```

## Files to Create/Modify

### Files to CREATE

#### 1. `~/.openclaw/metrics.db` (SQLite Database)

**Purpose**: Central metrics repository with tamper-evident design

```sql
-- Schema will be created by migration script
-- Tables: cortex_metrics, synapse_metrics, pipeline_metrics, sop_events
-- WAL mode for concurrent writes
-- Timestamp-based partitioning for performance
```

#### 2. `~/Projects/helios/extensions/cortex/pipeline/task-002-metrics-instrumentation/metrics-schema.sql`

**Purpose**: Database schema definition with indexes

- Create tables with appropriate data types
- Add indexes for common query patterns
- Enable WAL mode for concurrent access
- Add version metadata table

#### 3. `~/Projects/helios/extensions/cortex/python/metrics_writer.py`

**Purpose**: Lightweight SQLite metrics writer

- Async write operations to prevent blocking
- Connection pooling for performance
- Retry logic for database lock contention
- Type validation for metric data

#### 4. `~/Projects/helios/extensions/cortex/sop/qa-report-template.md`

**Purpose**: Standardized QA reporting with raw SQL queries

- Template sections with actual SQL queries
- No agent-editorialized content allowed
- Copy-paste queries for verification
- Daily/weekly/monthly variants

#### 5. `~/Projects/helios/extensions/cortex/scripts/daily-metrics-cron.sh`

**Purpose**: Daily automated metrics aggregation

- Queries metrics.db directly
- Outputs structured data for email
- Bypasses agent memory entirely
- Crontab-ready script

### Files to MODIFY

#### 1. `~/Projects/helios/extensions/cortex/index.ts`

**Lines to modify**: ~2478 (before_tool_call hook), ~1841 (before_agent_start hook)

**Changes**:

```typescript
// In before_tool_call hook (existing SOP enforcement)
const metricsWriter = await import("./python/metrics_writer.py");
await metricsWriter.writeSopEvent({
  timestamp: new Date().toISOString(),
  sop_name: sopName,
  tool_blocked: blocked,
  tool_name: toolName,
  acknowledged: false,
});

// In before_agent_start hook (memory injection logging)
await metricsWriter.writeCortexMetric({
  timestamp: new Date().toISOString(),
  metric_name: "memory_injected",
  metric_value: memoryCount,
  context: `tier_${tierName}_${category}`,
});
```

#### 2. `~/Projects/helios/extensions/cortex/cortex-bridge.ts`

**Lines to modify**: Synapse-related operations (~500-600 lines)

**Changes**:

- Add metrics logging to `synapseSend()`, `synapseAck()`, `synapseRead()`
- Measure latency with `performance.now()`
- Record thread relationships and agent communication patterns

#### 3. `~/Projects/helios/extensions/cortex/pipeline/state.json`

**Purpose**: Track pipeline metrics for each stage

- Add metrics logging to pipeline state transitions
- Record stage duration and results
- Enable pipeline performance analysis

## Data Model Changes

### Database Schema Design

```sql
-- Metrics Database Schema v1.0

CREATE TABLE cortex_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    context TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE synapse_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    action TEXT NOT NULL,  -- 'send', 'ack', 'read'
    thread_id TEXT,
    latency_ms REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE pipeline_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    result TEXT NOT NULL,  -- 'pass', 'fail', 'block'
    duration_ms REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    sop_name TEXT NOT NULL,
    tool_blocked BOOLEAN NOT NULL,
    tool_name TEXT,
    acknowledged BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Performance indexes
CREATE INDEX idx_cortex_timestamp ON cortex_metrics(timestamp);
CREATE INDEX idx_synapse_timestamp ON synapse_metrics(timestamp);
CREATE INDEX idx_pipeline_task ON pipeline_metrics(task_id);
CREATE INDEX idx_sop_events_name ON sop_events(sop_name);

-- Enable WAL mode for concurrent writes
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
```

## API/Interface Changes

### New Metrics Writer Interface

```python
# ~/Projects/helios/extensions/cortex/python/metrics_writer.py

class MetricsWriter:
    async def write_cortex_metric(self, metric_name: str, metric_value: float, context: str = None)
    async def write_synapse_metric(self, from_agent: str, to_agent: str, action: str, latency_ms: float = None)
    async def write_pipeline_metric(self, task_id: str, stage: str, result: str, duration_ms: float)
    async def write_sop_event(self, sop_name: str, tool_blocked: bool, tool_name: str = None)

    # Utility methods
    async def ensure_database_exists(self) -> bool
    async def get_connection_pool(self) -> Pool
    def format_timestamp(self) -> str
```

### TypeScript Integration

```typescript
// Type definitions for metrics integration
interface MetricEvent {
  timestamp: string;
  metric_name: string;
  metric_value: number;
  context?: string;
}

interface SopEvent {
  timestamp: string;
  sop_name: string;
  tool_blocked: boolean;
  tool_name?: string;
}
```

## Integration Points with Existing Systems

### 1. Cortex Extension Integration

**Hook Points**:

- `before_tool_call` (line ~2478): Add SOP event logging
- `before_agent_start` (line ~1841): Add memory injection logging
- `onMemoryInjection` (custom hook): Track memory tier usage

**Data Flow**:

```
SOP Enforcement → MetricsWriter.writeSopEvent() → SQLite
Memory Injection → MetricsWriter.writeCortexMetric() → SQLite
Tool Blocking → MetricsWriter.writeSopEvent() → SQLite
```

### 2. Synapse System Integration

**Hook Points**:

- Message send operations: Record sender, receiver, timestamp
- Message acknowledgment: Record latency, thread relationship
- Message reading: Track access patterns

**Data Flow**:

```
synapseSend() → start_time → MetricsWriter.writeSynapseMetric()
synapseAck() → latency_calc → MetricsWriter.writeSynapseMetric()
synapseRead() → access_log → MetricsWriter.writeSynapseMetric()
```

### 3. Pipeline System Integration

**Hook Points**:

- Stage start/completion: Duration measurement
- Task state changes: Success/failure tracking
- Deployment events: Version and timing data

**Data Flow**:

```
Pipeline Stage → performance.now() → duration_calc → MetricsWriter.writePipelineMetric()
```

## Risk Assessment

### HIGH RISK: Database Lock Contention

**Problem**: Multiple concurrent writes to SQLite may cause locking issues
**Mitigation Strategy**:

- WAL mode enables concurrent reads during writes
- Connection pooling with max 5 concurrent writers
- Async writes with retry logic (max 3 retries, exponential backoff)
- Fallback to in-memory queue if database unavailable

**Implementation**:

```python
async def write_with_retry(self, query, params, max_retries=3):
    for attempt in range(max_retries):
        try:
            async with self.get_connection() as conn:
                await conn.execute(query, params)
            return True
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e) and attempt < max_retries - 1:
                await asyncio.sleep(0.1 * (2 ** attempt))  # Exponential backoff
                continue
            raise e
```

### MEDIUM RISK: Performance Impact

**Problem**: Metrics collection could slow cortex operations
**Mitigation Strategy**:

- Asynchronous writes (non-blocking)
- Minimal data collection (only essential metrics)
- Local SQLite (no network overhead)
- Batch writes for high-frequency events

### MEDIUM RISK: Storage Growth

**Problem**: Metrics database may grow large over time  
**Mitigation Strategy**:

- Daily aggregation reduces raw data retention needs
- Indexes on timestamp columns for efficient queries
- Future: Implement data retention policies

### LOW RISK: Schema Evolution

**Problem**: Adding new metrics may require database migrations
**Mitigation Strategy**:

- Version metadata in database
- Backward-compatible schema changes
- Migration scripts for major changes

## Estimated Complexity: LARGE (L)

**Reasoning**:

- **Multiple Integration Points**: 3 major systems (Cortex, Synapse, Pipeline)
- **Concurrent Programming**: Async SQLite writes with retry logic
- **Data Consistency**: Tamper-evident design requires careful implementation
- **Performance Requirements**: Must not impact existing operations
- **Cross-Language Integration**: TypeScript to Python bridge for metrics

**Effort Breakdown**:

- Database schema and setup: 20%
- Cortex instrumentation: 30%
- Synapse instrumentation: 25%
- QA reporting template: 15%
- Testing and optimization: 10%

## Success Metrics

### Technical Metrics

- Database write latency < 1ms (99th percentile)
- Zero impact on cortex operation performance
- 100% SOP event capture rate
- 100% memory injection logging accuracy

### Business Metrics

- QA reports generate without agent involvement
- All metrics verifiable via raw SQL queries
- Daily aggregation runs automatically
- Matthew can independently verify all reported numbers

## Next Steps for Implementation

1. **Document Stage**: Update documentation first (docs-before-code)
2. **Build Stage**: Implement schema, writer, instrumentation
3. **Security Review**: Verify tamper-evident properties
4. **Test Stage**: Validate metrics accuracy and performance
5. **Deploy Stage**: Version bump, tag release, update registry
