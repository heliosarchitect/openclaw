#!/bin/bash
# Daily Metrics Aggregation Script
# Task: task-002-metrics-instrumentation
# Version: 1.0.0
# Date: 2026-02-17
#
# PURPOSE: Automated daily metrics aggregation that queries metrics.db directly
# No agent involvement - tamper-evident reporting
#
# USAGE: Add to crontab for nightly execution
# 0 2 * * * /path/to/daily-metrics-cron.sh

set -euo pipefail

# Configuration
METRICS_DB="$HOME/.openclaw/metrics.db"
REPORT_DIR="$HOME/.openclaw/reports"
DATE=$(date '+%Y-%m-%d')
REPORT_FILE="$REPORT_DIR/daily-metrics-$DATE.txt"
EMAIL_RECIPIENT="bonsaihorn@gmail.com"  # Matthew's email

# Ensure directories exist
mkdir -p "$REPORT_DIR"

# Verify database exists
if [ ! -f "$METRICS_DB" ]; then
    echo "ERROR: Metrics database not found at $METRICS_DB"
    exit 1
fi

# Generate daily metrics report
cat > "$REPORT_FILE" << EOF
DAILY METRICS REPORT - $DATE
Generated: $(date -u)
Database: $METRICS_DB
Report Type: Automated (no agent involvement)

===============================================
EXECUTIVE SUMMARY
===============================================
EOF

# Database stats
echo "DATABASE STATISTICS:" >> "$REPORT_FILE"
sqlite3 "$METRICS_DB" << SQL >> "$REPORT_FILE"
SELECT 'Total cortex metrics: ' || COUNT(*) FROM cortex_metrics;
SELECT 'Total synapse metrics: ' || COUNT(*) FROM synapse_metrics;
SELECT 'Total pipeline metrics: ' || COUNT(*) FROM pipeline_metrics;
SELECT 'Total SOP events: ' || COUNT(*) FROM sop_events;
SELECT 'Database size (KB): ' || ROUND((page_count * page_size) / 1024.0, 2) FROM pragma_page_count(), pragma_page_size();
SQL

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "SOP ENFORCEMENT (Last 24 Hours)" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"

sqlite3 "$METRICS_DB" << SQL >> "$REPORT_FILE"
.mode column
.headers on
SELECT 
    sop_name,
    COUNT(*) as total_checks,
    COUNT(CASE WHEN tool_blocked = 1 THEN 1 END) as blocks,
    COUNT(CASE WHEN tool_blocked = 0 THEN 1 END) as allowed,
    ROUND(100.0 * COUNT(CASE WHEN tool_blocked = 0 THEN 1 END) / COUNT(*), 2) as compliance_rate
FROM sop_events 
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
GROUP BY sop_name 
ORDER BY total_checks DESC;
SQL

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "MEMORY SYSTEM ACTIVITY (Last 24 Hours)" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"

sqlite3 "$METRICS_DB" << SQL >> "$REPORT_FILE"
.mode column
.headers on
SELECT 
    metric_name,
    COUNT(*) as events,
    ROUND(AVG(metric_value), 2) as avg_value,
    ROUND(SUM(metric_value), 2) as total_value,
    context
FROM cortex_metrics 
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
GROUP BY metric_name, context
ORDER BY events DESC;
SQL

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "SYNAPSE COMMUNICATION (Last 24 Hours)" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"

sqlite3 "$METRICS_DB" << SQL >> "$REPORT_FILE"
.mode column
.headers on
SELECT 
    from_agent,
    to_agent,
    action,
    COUNT(*) as message_count,
    ROUND(AVG(latency_ms), 2) as avg_latency_ms
FROM synapse_metrics 
WHERE datetime(timestamp) >= datetime('now', '-24 hours')
  AND latency_ms IS NOT NULL
GROUP BY from_agent, to_agent, action
ORDER BY message_count DESC
LIMIT 20;
SQL

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "PIPELINE PERFORMANCE (Last 7 Days)" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"

sqlite3 "$METRICS_DB" << SQL >> "$REPORT_FILE"
.mode column
.headers on
SELECT 
    stage,
    COUNT(*) as executions,
    ROUND(AVG(duration_ms), 2) as avg_duration_ms,
    COUNT(CASE WHEN result = 'pass' THEN 1 END) as successful,
    COUNT(CASE WHEN result = 'fail' THEN 1 END) as failed,
    ROUND(100.0 * COUNT(CASE WHEN result = 'pass' THEN 1 END) / COUNT(*), 2) as success_rate
FROM pipeline_metrics 
WHERE datetime(timestamp) >= datetime('now', '-7 days')
GROUP BY stage
ORDER BY avg_duration_ms DESC;
SQL

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "FAILURES & ANOMALIES (Last 24 Hours)" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"

sqlite3 "$METRICS_DB" << SQL >> "$REPORT_FILE"
.mode column
.headers on
SELECT 
    timestamp,
    'Pipeline Failure' as type,
    task_id || ' ' || stage || ' = ' || result as details
FROM pipeline_metrics 
WHERE result != 'pass' 
  AND datetime(timestamp) >= datetime('now', '-24 hours')
UNION ALL
SELECT 
    timestamp,
    'Unacknowledged SOP Block' as type,
    sop_name || ' blocked ' || tool_name as details
FROM sop_events
WHERE tool_blocked = 1 
  AND acknowledged = 0
  AND datetime(timestamp) >= datetime('now', '-24 hours')
ORDER BY timestamp DESC
LIMIT 10;
SQL

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "VERIFICATION QUERIES" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "Copy these queries to verify data independently:" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

cat >> "$REPORT_FILE" << 'SQL_QUERIES'
-- SOP blocks today:
SELECT count(*) FROM sop_events WHERE date(timestamp)=date('now') AND tool_blocked=1;

-- Memory injections today:
SELECT COUNT(*) FROM cortex_metrics WHERE date(timestamp)=date('now') AND metric_name='memory_injected';

-- Synapse messages today:
SELECT COUNT(*) FROM synapse_metrics WHERE date(timestamp)=date('now');

-- Pipeline stages today:
SELECT stage, COUNT(*) FROM pipeline_metrics WHERE date(timestamp)=date('now') GROUP BY stage;

-- Database integrity check:
PRAGMA integrity_check;
SQL_QUERIES

echo "" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "REPORT METADATA" >> "$REPORT_FILE"
echo "===============================================" >> "$REPORT_FILE"
echo "Generated by: daily-metrics-cron.sh (automated)" >> "$REPORT_FILE"
echo "Data source: $METRICS_DB (direct SQLite queries)" >> "$REPORT_FILE"
echo "Agent involvement: NONE (tamper-evident)" >> "$REPORT_FILE"
echo "Report timestamp: $(date -u)" >> "$REPORT_FILE"
echo "Hostname: $(hostname)" >> "$REPORT_FILE"

# Calculate and append report hash for tamper detection
REPORT_HASH=$(sha256sum "$REPORT_FILE" | cut -d' ' -f1)
echo "Report SHA256: $REPORT_HASH" >> "$REPORT_FILE"

# Log successful generation
echo "$(date): Daily metrics report generated: $REPORT_FILE" >> "$HOME/.openclaw/logs/metrics-cron.log"

# Optional: Send email if mail is configured
if command -v mail >/dev/null 2>&1; then
    mail -s "Daily Metrics Report - $DATE" "$EMAIL_RECIPIENT" < "$REPORT_FILE" || true
fi

# Optional: Clean up old reports (keep last 30 days)
find "$REPORT_DIR" -name "daily-metrics-*.txt" -mtime +30 -delete 2>/dev/null || true

# Success
echo "Daily metrics report generated successfully: $REPORT_FILE"
exit 0