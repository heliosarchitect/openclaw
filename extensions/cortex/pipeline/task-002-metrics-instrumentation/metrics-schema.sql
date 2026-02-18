-- Metrics Database Schema v1.0
-- Task: task-002-metrics-instrumentation  
-- Purpose: Tamper-evident metrics collection for cortex and synapse
-- Date: 2026-02-17

-- Enable WAL mode for concurrent access
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

-- Schema version tracking
CREATE TABLE schema_version (
    version TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

INSERT INTO schema_version (version, description) 
VALUES ('1.0.0', 'Initial metrics system schema');

-- Cortex metrics: memory injection, confidence scoring, SOP blocks
CREATE TABLE cortex_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- ISO 8601 format: YYYY-MM-DDTHH:MM:SS.sssZ
    metric_name TEXT NOT NULL,         -- 'memory_injected', 'confidence_score', 'sop_block_fired'
    metric_value REAL NOT NULL,        -- Numeric metric value (count, score, etc.)
    context TEXT,                      -- Additional context: 'tier_stm_trading', 'sop_comfyui'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT chk_timestamp_format CHECK (timestamp GLOB '????-??-??T??:??:??.???Z'),
    CONSTRAINT chk_metric_value_range CHECK (metric_value >= 0)
);

-- Synapse metrics: inter-agent communication tracking  
CREATE TABLE synapse_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- Message/operation timestamp
    from_agent TEXT NOT NULL,          -- Sender agent ID ('helios', 'claude-code', etc.)
    to_agent TEXT NOT NULL,            -- Recipient agent ID ('all', specific agent)
    action TEXT NOT NULL,              -- 'send', 'ack', 'read', 'inbox', 'history'
    thread_id TEXT,                    -- Thread/conversation ID for grouping
    latency_ms REAL,                   -- Operation latency in milliseconds
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT chk_timestamp_format CHECK (timestamp GLOB '????-??-??T??:??:??.???Z'),
    CONSTRAINT chk_action_values CHECK (action IN ('send', 'ack', 'read', 'inbox', 'history')),
    CONSTRAINT chk_latency_positive CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

-- Pipeline metrics: development pipeline stage tracking
CREATE TABLE pipeline_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    timestamp TEXT NOT NULL,           -- Stage completion timestamp
    task_id TEXT NOT NULL,             -- 'task-002-metrics-instrumentation'
    stage TEXT NOT NULL,               -- 'requirements', 'design', 'build', 'test', 'deploy'
    result TEXT NOT NULL,              -- 'pass', 'fail', 'block'
    duration_ms REAL,                  -- Stage execution time in milliseconds
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT chk_timestamp_format CHECK (timestamp GLOB '????-??-??T??:??:??.???Z'),
    CONSTRAINT chk_stage_values CHECK (stage IN ('bugfix', 'requirements', 'design', 'document', 'build', 'security', 'test', 'deploy')),
    CONSTRAINT chk_result_values CHECK (result IN ('pass', 'fail', 'block')),
    CONSTRAINT chk_duration_positive CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

-- SOP events: standard operating procedure enforcement
CREATE TABLE sop_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- SOP enforcement timestamp  
    sop_name TEXT NOT NULL,            -- 'comfyui.ai.sop', 'ft991a.ai.sop'
    tool_blocked BOOLEAN NOT NULL,     -- Whether tool was blocked (1) or allowed (0)
    tool_name TEXT,                    -- Name of tool that was evaluated
    acknowledged BOOLEAN DEFAULT FALSE,-- Whether user acknowledged the block
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- Constraints
    CONSTRAINT chk_timestamp_format CHECK (timestamp GLOB '????-??-??T??:??:??.???Z'),
    CONSTRAINT chk_tool_blocked_bool CHECK (tool_blocked IN (0, 1)),
    CONSTRAINT chk_acknowledged_bool CHECK (acknowledged IN (0, 1))
);

-- Performance indexes for common query patterns
CREATE INDEX idx_cortex_metrics_timestamp ON cortex_metrics(timestamp);
CREATE INDEX idx_cortex_metrics_name_time ON cortex_metrics(metric_name, timestamp); 
CREATE INDEX idx_cortex_metrics_date ON cortex_metrics(date(timestamp));

CREATE INDEX idx_synapse_metrics_timestamp ON synapse_metrics(timestamp);
CREATE INDEX idx_synapse_metrics_agents ON synapse_metrics(from_agent, to_agent);
CREATE INDEX idx_synapse_metrics_thread ON synapse_metrics(thread_id);
CREATE INDEX idx_synapse_metrics_date ON synapse_metrics(date(timestamp));

CREATE INDEX idx_pipeline_metrics_task ON pipeline_metrics(task_id);
CREATE INDEX idx_pipeline_metrics_stage ON pipeline_metrics(stage);
CREATE INDEX idx_pipeline_metrics_timestamp ON pipeline_metrics(timestamp);
CREATE INDEX idx_pipeline_metrics_date ON pipeline_metrics(date(timestamp));

CREATE INDEX idx_sop_events_name ON sop_events(sop_name);
CREATE INDEX idx_sop_events_blocked ON sop_events(tool_blocked);
CREATE INDEX idx_sop_events_timestamp ON sop_events(timestamp);
CREATE INDEX idx_sop_events_date ON sop_events(date(timestamp));

-- Create views for common aggregations
CREATE VIEW daily_cortex_summary AS
SELECT 
    date(timestamp) as date,
    metric_name,
    COUNT(*) as event_count,
    AVG(metric_value) as avg_value,
    MIN(metric_value) as min_value,
    MAX(metric_value) as max_value
FROM cortex_metrics 
GROUP BY date(timestamp), metric_name;

CREATE VIEW daily_sop_summary AS  
SELECT
    date(timestamp) as date,
    sop_name,
    COUNT(*) as total_checks,
    COUNT(CASE WHEN tool_blocked = 1 THEN 1 END) as blocks,
    COUNT(CASE WHEN tool_blocked = 0 THEN 1 END) as allowed,
    ROUND(100.0 * COUNT(CASE WHEN tool_blocked = 0 THEN 1 END) / COUNT(*), 2) as compliance_rate
FROM sop_events
GROUP BY date(timestamp), sop_name;

CREATE VIEW synapse_latency_summary AS
SELECT
    date(timestamp) as date,
    action,
    from_agent,
    to_agent,
    COUNT(*) as message_count,
    ROUND(AVG(latency_ms), 2) as avg_latency_ms,
    ROUND(MIN(latency_ms), 2) as min_latency_ms, 
    ROUND(MAX(latency_ms), 2) as max_latency_ms,
    COUNT(CASE WHEN latency_ms > 1000 THEN 1 END) as slow_operations
FROM synapse_metrics
WHERE latency_ms IS NOT NULL
GROUP BY date(timestamp), action, from_agent, to_agent;

-- Insert initial test data to verify schema
INSERT INTO cortex_metrics (timestamp, metric_name, metric_value, context) 
VALUES ('2026-02-17T21:30:00.000Z', 'schema_created', 1.0, 'initial_setup');

INSERT INTO sop_events (timestamp, sop_name, tool_blocked, tool_name, acknowledged)
VALUES ('2026-02-17T21:30:00.000Z', 'metrics.ai.sop', 0, 'create_schema', 1);

INSERT INTO pipeline_metrics (timestamp, task_id, stage, result, duration_ms)
VALUES ('2026-02-17T21:30:00.000Z', 'task-002-metrics-instrumentation', 'build', 'pass', 0);

-- Final verification
SELECT 'Schema created successfully. Version: ' || version as status 
FROM schema_version WHERE version = '1.0.0';