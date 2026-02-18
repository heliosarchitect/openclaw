#!/usr/bin/env python3
"""
Tamper-Evident Metrics Writer for Cortex System
Task: task-002-metrics-instrumentation
Version: 1.0.0
Date: 2026-02-17

This module provides lightweight, async SQLite writes for metrics collection.
Key principle: ONLY INSTRUMENTED CODE writes metrics, never agent self-reporting.
"""

import sqlite3
import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List
from pathlib import Path
import logging
import threading
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MetricsWriter:
    """
    SQLite metrics writer with retry logic for database lock contention.
    Designed for high-frequency, low-latency metric collection.
    """
    
    def __init__(self, db_path: str = None):
        self.db_path = db_path or os.path.expanduser("~/.openclaw/metrics.db")
        self.max_retries = 3
        self.retry_base_delay = 0.1  # 100ms base delay
        self._lock = threading.Lock()
        
    def ensure_database_exists(self) -> bool:
        """Verify database and schema exist, create if needed."""
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
            
            # Check if database exists and has correct schema
            with sqlite3.connect(self.db_path) as conn:
                # Verify schema version
                cursor = conn.execute(
                    "SELECT version FROM schema_version WHERE version = '1.0.0'"
                )
                result = cursor.fetchone()
                
                if result:
                    logger.info(f"Metrics database ready at {self.db_path}")
                    return True
                else:
                    logger.error("Database exists but schema version mismatch")
                    return False
                    
        except sqlite3.Error as e:
            logger.error(f"Database verification failed: {e}")
            return False
    
    def format_timestamp(self) -> str:
        """Generate ISO 8601 timestamp in UTC with milliseconds."""
        now = datetime.now(timezone.utc)
        # Format with exactly 3 decimal places for milliseconds
        timestamp = now.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
        return timestamp
    
    def _execute_with_retry(self, query: str, params: tuple) -> bool:
        """Execute query with retry logic for database lock contention."""
        for attempt in range(self.max_retries):
            try:
                with sqlite3.connect(self.db_path) as conn:
                    # Enable WAL mode and optimize for writes
                    conn.execute("PRAGMA journal_mode=WAL")
                    conn.execute("PRAGMA synchronous=NORMAL")
                    
                    # Execute the query
                    conn.execute(query, params)
                    conn.commit()
                    
                    return True
                    
            except sqlite3.OperationalError as e:
                if "database is locked" in str(e) and attempt < self.max_retries - 1:
                    # Exponential backoff
                    delay = self.retry_base_delay * (2 ** attempt)
                    logger.warning(f"Database locked, retrying in {delay}s (attempt {attempt + 1})")
                    time.sleep(delay)
                    continue
                else:
                    logger.error(f"Database operation failed: {e}")
                    return False
            except Exception as e:
                logger.error(f"Unexpected error in metrics write: {e}")
                return False
        
        logger.error(f"Failed to execute query after {self.max_retries} attempts")
        return False
    
    def write_cortex_metric(self, 
                           metric_name: str, 
                           metric_value: float, 
                           context: Optional[str] = None) -> bool:
        """
        Write cortex metric (memory injection, confidence score, etc.)
        
        Args:
            metric_name: Type of metric ('memory_injected', 'confidence_score')
            metric_value: Numeric value (count, score, percentage)
            context: Additional context ('tier_stm_trading', 'sop_block_fired')
        """
        timestamp = self.format_timestamp()
        
        query = """
        INSERT INTO cortex_metrics (timestamp, metric_name, metric_value, context)
        VALUES (?, ?, ?, ?)
        """
        params = (timestamp, metric_name, metric_value, context)
        
        success = self._execute_with_retry(query, params)
        if success:
            logger.debug(f"Cortex metric written: {metric_name}={metric_value} ({context})")
        
        return success
    
    def write_synapse_metric(self,
                            from_agent: str,
                            to_agent: str, 
                            action: str,
                            thread_id: Optional[str] = None,
                            latency_ms: Optional[float] = None) -> bool:
        """
        Write synapse communication metric.
        
        Args:
            from_agent: Sending agent ID ('helios', 'claude-code')
            to_agent: Receiving agent ID ('all', specific agent)  
            action: Communication action ('send', 'ack', 'read')
            thread_id: Thread/conversation ID for grouping
            latency_ms: Operation latency in milliseconds
        """
        timestamp = self.format_timestamp()
        
        query = """
        INSERT INTO synapse_metrics (timestamp, from_agent, to_agent, action, thread_id, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        """
        params = (timestamp, from_agent, to_agent, action, thread_id, latency_ms)
        
        success = self._execute_with_retry(query, params)
        if success:
            logger.debug(f"Synapse metric written: {from_agent}→{to_agent} {action} ({latency_ms}ms)")
            
        return success
    
    def write_pipeline_metric(self,
                             task_id: str,
                             stage: str,
                             result: str,
                             duration_ms: Optional[float] = None) -> bool:
        """
        Write pipeline performance metric.
        
        Args:
            task_id: Pipeline task ID ('task-002-metrics-instrumentation')
            stage: Pipeline stage ('requirements', 'design', 'build', etc.)
            result: Stage result ('pass', 'fail', 'block')
            duration_ms: Stage execution time in milliseconds
        """
        timestamp = self.format_timestamp()
        
        query = """
        INSERT INTO pipeline_metrics (timestamp, task_id, stage, result, duration_ms)
        VALUES (?, ?, ?, ?, ?)
        """
        params = (timestamp, task_id, stage, result, duration_ms)
        
        success = self._execute_with_retry(query, params)
        if success:
            logger.debug(f"Pipeline metric written: {task_id} {stage}={result} ({duration_ms}ms)")
            
        return success
    
    def write_sop_event(self,
                       sop_name: str,
                       tool_blocked: bool,
                       tool_name: Optional[str] = None,
                       acknowledged: bool = False) -> bool:
        """
        Write SOP enforcement event.
        
        Args:
            sop_name: SOP file name ('comfyui.ai.sop', 'metrics.ai.sop')  
            tool_blocked: Whether tool was blocked (True) or allowed (False)
            tool_name: Name of tool that was evaluated
            acknowledged: Whether user acknowledged the block
        """
        timestamp = self.format_timestamp()
        
        query = """
        INSERT INTO sop_events (timestamp, sop_name, tool_blocked, tool_name, acknowledged)
        VALUES (?, ?, ?, ?, ?)
        """
        params = (timestamp, sop_name, 1 if tool_blocked else 0, tool_name, 1 if acknowledged else 0)
        
        success = self._execute_with_retry(query, params)
        if success:
            action = "BLOCKED" if tool_blocked else "ALLOWED"
            logger.debug(f"SOP event written: {sop_name} {action} {tool_name}")
            
        return success
    
    def write_batch_metrics(self, metrics: List[Dict[str, Any]]) -> int:
        """
        Write multiple metrics in a single transaction for efficiency.
        
        Args:
            metrics: List of metric dictionaries with 'type' and parameters
            
        Returns:
            Number of metrics successfully written
        """
        success_count = 0
        
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                
                for metric in metrics:
                    try:
                        metric_type = metric.get('type')
                        timestamp = self.format_timestamp()
                        
                        if metric_type == 'cortex':
                            query = "INSERT INTO cortex_metrics (timestamp, metric_name, metric_value, context) VALUES (?, ?, ?, ?)"
                            params = (timestamp, metric['metric_name'], metric['metric_value'], metric.get('context'))
                        
                        elif metric_type == 'synapse':
                            query = "INSERT INTO synapse_metrics (timestamp, from_agent, to_agent, action, thread_id, latency_ms) VALUES (?, ?, ?, ?, ?, ?)"
                            params = (timestamp, metric['from_agent'], metric['to_agent'], metric['action'], 
                                    metric.get('thread_id'), metric.get('latency_ms'))
                        
                        elif metric_type == 'pipeline':
                            query = "INSERT INTO pipeline_metrics (timestamp, task_id, stage, result, duration_ms) VALUES (?, ?, ?, ?, ?)"
                            params = (timestamp, metric['task_id'], metric['stage'], metric['result'], metric.get('duration_ms'))
                        
                        elif metric_type == 'sop':
                            query = "INSERT INTO sop_events (timestamp, sop_name, tool_blocked, tool_name, acknowledged) VALUES (?, ?, ?, ?, ?)"
                            params = (timestamp, metric['sop_name'], 1 if metric['tool_blocked'] else 0, 
                                    metric.get('tool_name'), 1 if metric.get('acknowledged', False) else 0)
                        
                        else:
                            logger.warning(f"Unknown metric type: {metric_type}")
                            continue
                            
                        conn.execute(query, params)
                        success_count += 1
                        
                    except Exception as e:
                        logger.error(f"Failed to write batch metric: {e}")
                        continue
                
                conn.commit()
                
        except Exception as e:
            logger.error(f"Batch write failed: {e}")
        
        logger.info(f"Batch write completed: {success_count}/{len(metrics)} metrics written")
        return success_count
    
    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics for monitoring."""
        try:
            with sqlite3.connect(self.db_path) as conn:
                stats = {}
                
                # Row counts per table
                for table in ['cortex_metrics', 'synapse_metrics', 'pipeline_metrics', 'sop_events']:
                    cursor = conn.execute(f"SELECT COUNT(*) FROM {table}")
                    count = cursor.fetchone()
                    stats[f"{table}_count"] = count[0] if count else 0
                
                # Database size
                cursor = conn.execute("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
                size = cursor.fetchone()
                stats['db_size_bytes'] = size[0] if size else 0
                
                # Recent activity (last 24 hours)
                cursor = conn.execute(
                    "SELECT COUNT(*) FROM cortex_metrics WHERE datetime(timestamp) >= datetime('now', '-24 hours')"
                )
                recent = cursor.fetchone()
                stats['recent_cortex_activity'] = recent[0] if recent else 0
                
                return stats
                
        except Exception as e:
            logger.error(f"Failed to get stats: {e}")
            return {}

# Direct functions for TypeScript integration (all methods are now synchronous)
def write_cortex_metric_sync(metric_name: str, metric_value: float, context: str = None) -> bool:
    """Write cortex metric."""
    writer = MetricsWriter()
    return writer.write_cortex_metric(metric_name, metric_value, context)

def write_synapse_metric_sync(from_agent: str, to_agent: str, action: str, 
                            thread_id: str = None, latency_ms: float = None) -> bool:
    """Write synapse metric."""
    writer = MetricsWriter()
    return writer.write_synapse_metric(from_agent, to_agent, action, thread_id, latency_ms)

def write_pipeline_metric_sync(task_id: str, stage: str, result: str, duration_ms: float = None) -> bool:
    """Write pipeline metric."""
    writer = MetricsWriter()
    return writer.write_pipeline_metric(task_id, stage, result, duration_ms)

def write_sop_event_sync(sop_name: str, tool_blocked: bool, tool_name: str = None, acknowledged: bool = False) -> bool:
    """Write SOP event."""
    writer = MetricsWriter()
    return writer.write_sop_event(sop_name, tool_blocked, tool_name, acknowledged)

# CLI interface for testing and maintenance
def main():
    """CLI interface for testing metrics writer."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Metrics Writer CLI")
    parser.add_argument("--test", action="store_true", help="Run test writes")
    parser.add_argument("--stats", action="store_true", help="Show database stats")
    parser.add_argument("--verify", action="store_true", help="Verify database schema")
    
    args = parser.parse_args()
    writer = MetricsWriter()
    
    if args.verify:
        exists = writer.ensure_database_exists()
        print(f"Database verification: {'PASS' if exists else 'FAIL'}")
    
    if args.stats:
        stats = writer.get_stats()
        print("Database Statistics:")
        for key, value in stats.items():
            print(f"  {key}: {value}")
    
    if args.test:
        print("Running test writes...")
        
        # Test cortex metric
        success1 = writer.write_cortex_metric("test_metric", 42.0, "cli_test")
        print(f"Cortex metric: {'SUCCESS' if success1 else 'FAILED'}")
        
        # Test synapse metric  
        success2 = writer.write_synapse_metric("test_agent", "test_target", "send", "test_thread", 123.45)
        print(f"Synapse metric: {'SUCCESS' if success2 else 'FAILED'}")
        
        # Test pipeline metric
        success3 = writer.write_pipeline_metric("test-task", "test", "pass", 456.78)
        print(f"Pipeline metric: {'SUCCESS' if success3 else 'FAILED'}")
        
        # Test SOP event
        success4 = writer.write_sop_event("test.ai.sop", False, "test_tool", True)
        print(f"SOP event: {'SUCCESS' if success4 else 'FAILED'}")
        
        all_success = all([success1, success2, success3, success4])
        print(f"\nOverall test result: {'PASS' if all_success else 'FAIL'}")

if __name__ == "__main__":
    main()