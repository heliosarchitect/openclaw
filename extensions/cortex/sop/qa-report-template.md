# QA Report Template - Cortex Metrics System

**Version**: 1.0  
**Generated**: [DATE - AUTOMATICALLY FILLED]  
**Reporting Period**: [START_DATE] to [END_DATE]  
**Database**: ~/.openclaw/metrics.db

---

## Executive Summary

**Report Period**: [PERIOD]  
**Cortex Version**: [VERSION]  
**Metrics Database Size**: [SIZE_MB] MB  
**Total Events Recorded**: [TOTAL_EVENTS]

**Key Findings**:

- SOP Enforcement: [SOP_BLOCKS] blocks, [SOP_SUCCESS_RATE]% compliance
- Memory System: [MEMORY_INJECTIONS] injections, [MEMORY_TIERS] tiers active
- Synapse Health: [SYNAPSE_MESSAGES] messages, [SYNAPSE_AVG_LATENCY]ms avg latency
- Pipeline Performance: [PIPELINE_STAGES] stages completed, [PIPELINE_SUCCESS_RATE]% success rate

---

## SOP Enforcement Analysis

### SOP Blocks (Last 24 Hours)

```sql
SELECT
  sop_name,
  COUNT(*) as total_blocks,
  COUNT(CASE WHEN tool_blocked = 1 THEN 1 END) as actual_blocks,
  COUNT(CASE WHEN acknowledged = 1 THEN 1 END) as acknowledged_blocks
FROM sop_events
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
GROUP BY sop_name
ORDER BY total_blocks DESC;
```

### Most Blocked Tools (Last 7 Days)

```sql
SELECT
  tool_name,
  sop_name,
  COUNT(*) as block_count
FROM sop_events
WHERE datetime(timestamp) >= datetime('now', '-7 days')
  AND tool_blocked = 1
GROUP BY tool_name, sop_name
ORDER BY block_count DESC
LIMIT 10;
```

### SOP Compliance Trend (Daily)

```sql
SELECT
  date(timestamp) as date,
  COUNT(*) as total_sop_checks,
  COUNT(CASE WHEN tool_blocked = 1 THEN 1 END) as blocks,
  ROUND(100.0 * COUNT(CASE WHEN tool_blocked = 0 THEN 1 END) / COUNT(*), 2) as compliance_rate
FROM sop_events
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY date(timestamp)
ORDER BY date DESC;
```

**Analysis**: [NO AGENT INTERPRETATION - RAW QUERY RESULTS ONLY]

---

## Memory Quality Assessment

### Memory Injection by Tier (Last 24 Hours)

```sql
SELECT
  context as memory_tier,
  COUNT(*) as injection_count,
  AVG(metric_value) as avg_memory_count
FROM cortex_metrics
WHERE metric_name = 'memory_injected'
  AND datetime(timestamp) >= datetime('now', '-24 hours')
GROUP BY context
ORDER BY injection_count DESC;
```

### Memory System Activity (Hourly Breakdown)

```sql
SELECT
  strftime('%Y-%m-%d %H:00', timestamp) as hour,
  COUNT(*) as memory_operations,
  SUM(metric_value) as total_memories_processed
FROM cortex_metrics
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
GROUP BY strftime('%Y-%m-%d %H:00', timestamp)
ORDER BY hour DESC;
```

### Memory Confidence Distribution

```sql
SELECT
  context,
  COUNT(*) as entries,
  ROUND(AVG(metric_value), 3) as avg_confidence
FROM cortex_metrics
WHERE metric_name LIKE '%confidence%'
  AND datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY context
ORDER BY entries DESC;
```

**Analysis**: [NO AGENT INTERPRETATION - RAW QUERY RESULTS ONLY]

---

## Synapse Health Report

### Inter-Agent Communication Volume

```sql
SELECT
  from_agent,
  to_agent,
  action,
  COUNT(*) as message_count,
  ROUND(AVG(latency_ms), 2) as avg_latency_ms
FROM synapse_metrics
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
GROUP BY from_agent, to_agent, action
ORDER BY message_count DESC
LIMIT 20;
```

### Synapse Latency Analysis

```sql
SELECT
  action,
  COUNT(*) as operations,
  ROUND(AVG(latency_ms), 2) as avg_latency,
  ROUND(MIN(latency_ms), 2) as min_latency,
  ROUND(MAX(latency_ms), 2) as max_latency,
  COUNT(CASE WHEN latency_ms > 1000 THEN 1 END) as slow_operations
FROM synapse_metrics
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
  AND latency_ms IS NOT NULL
GROUP BY action
ORDER BY avg_latency DESC;
```

### Thread Activity Analysis

```sql
SELECT
  thread_id,
  COUNT(*) as messages,
  COUNT(DISTINCT from_agent) as participants,
  MIN(timestamp) as thread_start,
  MAX(timestamp) as thread_last_activity
FROM synapse_metrics
WHERE datetime(timestamp) >= datetime('now', '-7 days')
  AND thread_id IS NOT NULL
GROUP BY thread_id
ORDER BY messages DESC
LIMIT 10;
```

**Analysis**: [NO AGENT INTERPRETATION - RAW QUERY RESULTS ONLY]

---

## Pipeline Performance

### Stage Completion Times (Last 7 Days)

```sql
SELECT
  stage,
  COUNT(*) as executions,
  ROUND(AVG(duration_ms), 2) as avg_duration_ms,
  ROUND(MIN(duration_ms), 2) as min_duration_ms,
  ROUND(MAX(duration_ms), 2) as max_duration_ms,
  COUNT(CASE WHEN result = 'pass' THEN 1 END) as successful,
  COUNT(CASE WHEN result = 'fail' THEN 1 END) as failed,
  COUNT(CASE WHEN result = 'block' THEN 1 END) as blocked
FROM pipeline_metrics
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY stage
ORDER BY avg_duration_ms DESC;
```

### Pipeline Success Rate by Task

```sql
SELECT
  task_id,
  COUNT(*) as total_stages,
  COUNT(CASE WHEN result = 'pass' THEN 1 END) as passed_stages,
  COUNT(CASE WHEN result = 'fail' THEN 1 END) as failed_stages,
  COUNT(CASE WHEN result = 'block' THEN 1 END) as blocked_stages,
  ROUND(100.0 * COUNT(CASE WHEN result = 'pass' THEN 1 END) / COUNT(*), 2) as success_rate
FROM pipeline_metrics
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY task_id
ORDER BY success_rate ASC;
```

### Recent Pipeline Failures

```sql
SELECT
  timestamp,
  task_id,
  stage,
  result,
  duration_ms
FROM pipeline_metrics
WHERE result != 'pass'
  AND datetime(timestamp) >= datetime('now', '-24 hours')
ORDER BY timestamp DESC
LIMIT 20;
```

**Analysis**: [NO AGENT INTERPRETATION - RAW QUERY RESULTS ONLY]

---

## Failures & Regressions

### System Error Pattern Detection

```sql
SELECT
  date(timestamp) as error_date,
  'sop_events' as source_table,
  COUNT(CASE WHEN tool_blocked = 1 AND acknowledged = 0 THEN 1 END) as unacknowledged_blocks
FROM sop_events
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY date(timestamp)
UNION ALL
SELECT
  date(timestamp) as error_date,
  'pipeline_metrics' as source_table,
  COUNT(CASE WHEN result = 'fail' THEN 1 END) as pipeline_failures
FROM pipeline_metrics
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY date(timestamp)
ORDER BY error_date DESC;
```

### Anomaly Detection (Statistical)

```sql
-- Detect days with unusual metric patterns
SELECT
  date(timestamp) as anomaly_date,
  COUNT(*) as total_events,
  COUNT(DISTINCT metric_name) as unique_metrics,
  ROUND(AVG(metric_value), 3) as avg_metric_value
FROM cortex_metrics
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY date(timestamp)
HAVING COUNT(*) < (
  SELECT AVG(daily_count) * 0.5
  FROM (
    SELECT COUNT(*) as daily_count
    FROM cortex_metrics
    WHERE datetime(timestamp) >= datetime('now', '-30 days')
    GROUP BY date(timestamp)
  )
)
ORDER BY anomaly_date DESC;
```

### Database Health Check

```sql
-- Verify database integrity
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

**Analysis**: [NO AGENT INTERPRETATION - RAW QUERY RESULTS ONLY]

---

## Verification Instructions

### Manual Query Execution

1. **Connect to database**: `sqlite3 ~/.openclaw/metrics.db`
2. **Copy any SQL query from this report**
3. **Paste and execute directly**
4. **Compare results with report values**

### Database Backup Verification

```bash
# Verify backup exists and is readable
ls -la ~/.openclaw/backups/metrics-*.db
sqlite3 ~/.openclaw/backups/metrics-$(date +%Y%m%d).db "SELECT count(*) FROM cortex_metrics;"
```

### Metrics Collection Verification

```bash
# Verify metrics are being written currently
tail -f ~/.openclaw/logs/gateway.log | grep "metrics_writer"
```

---

## Report Generation Metadata

**Generated by**: Automated cron job (NO agent involvement)  
**Data source**: ~/.openclaw/metrics.db (direct SQLite queries)  
**Query execution time**: [EXECUTION_TIME_MS] milliseconds  
**Database size at report time**: [DB_SIZE] MB  
**Total rows processed**: [TOTAL_ROWS]

**Verification hash**: [SHA256_OF_RAW_DATA] (for tamper detection)

---

## Notes

- **All metrics collected by instrumented code, not agent self-reporting**
- **Every SQL query in this report is executable and verifiable**
- **No agent interpretation or analysis - raw data only**
- **Report automatically generated via cron, no human editing**
- **Database queries are the single source of truth**

_End of Report_
