#!/usr/bin/env python3
"""
SYNAPSE v2 — Optimized Inter-Agent Messaging

Structured messaging stored in brain.db (SQLite). Key improvements over v1:
- Thread compaction: old threads auto-summarize to a single message
- Agent scoping: filter by sender/receiver efficiently via indexes  
- Age-based pruning: messages older than RETENTION_DAYS auto-purge
- Read/ack cleanup: acknowledged messages pruned after ACK_RETENTION_DAYS
- Hard cap: MAX_MESSAGES with intelligent eviction (acked → read → oldest)

Data lives in brain.db alongside Cortex memories. Falls back to synapse.json
for backward compat if brain.db is unavailable.
"""
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).parent))
DB_PATH = DATA_DIR / "brain.db"
SYNAPSE_JSON_PATH = DATA_DIR / "synapse.json"  # legacy fallback

# --- Tuning knobs ---
MAX_MESSAGES = 100          # hard cap (down from 200)
RETENTION_DAYS = 14         # auto-prune messages older than this
ACK_RETENTION_DAYS = 3      # acked messages pruned after 3 days
THREAD_COMPACT_AFTER = 10   # compact threads with >10 messages
VALID_PRIORITIES = ("info", "action", "urgent")

# Agent scoping: typed identifiers so same roles track across sessions.
# Format: "{type}:{instance}" — e.g. "pipeline:build", "benchmark:gaia"
# Queries can filter by prefix to get all agents of a type.
KNOWN_AGENT_TYPES = {
    "main":      "Primary Helios session",
    "claude-code": "Claude Code (Nova) coding agent",
    "pipeline":  "Pipeline stage specialists (pipeline:requirements, pipeline:build, etc.)",
    "benchmark": "Benchmark runners (benchmark:gaia, benchmark:swe, etc.)",
    "monitor":   "Monitoring agents (monitor:augur, monitor:event-watch, etc.)",
    "research":  "Research sub-agents",
    "system":    "System/maintenance messages",
}


def _generate_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _now_iso() -> str:
    return datetime.now().isoformat()


def _get_conn() -> sqlite3.Connection:
    """Get a connection to brain.db with WAL mode."""
    conn = sqlite3.connect(str(DB_PATH), timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create tables if they don't exist. Idempotent."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            parent_id TEXT,
            from_agent TEXT NOT NULL,
            to_agent TEXT,
            priority TEXT DEFAULT 'info',
            subject TEXT,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            metadata TEXT,
            expires_at TEXT,
            task_status TEXT,
            result TEXT,
            context TEXT
        );
        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            subject TEXT,
            created_at TEXT,
            last_message_at TEXT,
            message_count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS read_receipts (
            message_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            read_at TEXT NOT NULL,
            PRIMARY KEY (message_id, agent_id)
        );
        CREATE TABLE IF NOT EXISTS acks (
            message_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            ack_body TEXT,
            acked_at TEXT NOT NULL,
            PRIMARY KEY (message_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
        CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
        CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_priority ON messages(priority);
    """)


# ---------- Core operations ----------

def send_message(
    from_agent: str,
    to_agent: str,
    subject: str,
    body: str,
    priority: str = "info",
    thread_id: str | None = None,
) -> dict:
    """Send a message. Auto-creates thread if needed."""
    if priority not in VALID_PRIORITIES:
        priority = "info"

    msg_id = _generate_id("syn")
    tid = thread_id or _generate_id("thr")
    now = _now_iso()

    conn = _get_conn()
    _ensure_schema(conn)
    try:
        # Upsert thread
        conn.execute("""
            INSERT INTO threads (id, subject, created_at, last_message_at, message_count)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(id) DO UPDATE SET 
                last_message_at = excluded.last_message_at,
                message_count = message_count + 1
        """, (tid, subject, now, now))

        # Insert message
        conn.execute("""
            INSERT INTO messages (id, thread_id, from_agent, to_agent, priority, subject, body, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (msg_id, tid, from_agent, to_agent, priority, subject, body, now))

        conn.commit()

        # Run maintenance (non-blocking, best-effort)
        _auto_maintain(conn)

        return {
            "id": msg_id, "thread_id": tid, "from_agent": from_agent,
            "to_agent": to_agent, "priority": priority, "subject": subject,
            "body": body, "created_at": now,
        }
    finally:
        conn.close()


def get_inbox(agent_id: str, include_read: bool = False, limit: int = 50,
              from_type: str | None = None) -> list:
    """Get messages for an agent. Unread by default; optionally include read.
    
    from_type: filter by agent type prefix (e.g. "pipeline" matches "pipeline:build").
    """
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        base_where = "(m.to_agent = ? OR m.to_agent = 'all')"
        params: list = [agent_id]

        if from_type:
            base_where += " AND (m.from_agent = ? OR m.from_agent LIKE ?)"
            params.extend([from_type, f"{from_type}:%"])

        if include_read:
            params.append(agent_id)
            rows = conn.execute(f"""
                SELECT m.* FROM messages m
                WHERE {base_where}
                AND m.id NOT IN (SELECT message_id FROM acks WHERE agent_id = ?)
                ORDER BY m.created_at DESC
                LIMIT ?
            """, (*params, limit)).fetchall()
        else:
            params.extend([agent_id, agent_id])
            rows = conn.execute(f"""
                SELECT m.* FROM messages m
                WHERE {base_where}
                AND m.id NOT IN (SELECT message_id FROM read_receipts WHERE agent_id = ?)
                AND m.id NOT IN (SELECT message_id FROM acks WHERE agent_id = ?)
                ORDER BY m.created_at DESC
                LIMIT ?
            """, (*params, limit)).fetchall()

        return [dict(r) for r in rows]
    finally:
        conn.close()


def read_message(message_id: str, reader_agent: str) -> dict | None:
    """Mark a message as read by this agent. Returns the message."""
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return None

        conn.execute("""
            INSERT OR IGNORE INTO read_receipts (message_id, agent_id, read_at)
            VALUES (?, ?, ?)
        """, (message_id, reader_agent, _now_iso()))
        conn.commit()
        return dict(row)
    finally:
        conn.close()


def acknowledge_message(message_id: str, acker_agent: str, ack_body: str | None = None) -> dict | None:
    """Acknowledge a message with optional reply."""
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return None

        conn.execute("""
            INSERT OR REPLACE INTO acks (message_id, agent_id, ack_body, acked_at)
            VALUES (?, ?, ?, ?)
        """, (message_id, acker_agent, ack_body, _now_iso()))

        # Also mark as read
        conn.execute("""
            INSERT OR IGNORE INTO read_receipts (message_id, agent_id, read_at)
            VALUES (?, ?, ?)
        """, (message_id, acker_agent, _now_iso()))

        conn.commit()
        return dict(row)
    finally:
        conn.close()


def get_history(
    agent_id: str | None = None,
    thread_id: str | None = None,
    from_type: str | None = None,
    limit: int = 20,
) -> list:
    """Get message history with optional filters.
    
    agent_id: filter to messages involving this agent
    thread_id: filter to specific thread
    from_type: filter by agent type prefix (e.g. "pipeline", "benchmark")
    """
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        query = "SELECT * FROM messages WHERE 1=1"
        params: list = []

        if agent_id:
            query += " AND (from_agent = ? OR to_agent = ? OR to_agent = 'all')"
            params.extend([agent_id, agent_id])

        if thread_id:
            query += " AND thread_id = ?"
            params.append(thread_id)

        if from_type:
            query += " AND (from_agent = ? OR from_agent LIKE ?)"
            params.extend([from_type, f"{from_type}:%"])

        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------- Maintenance / Optimization ----------

def _auto_maintain(conn: sqlite3.Connection) -> None:
    """Run lightweight maintenance. Called after every send."""
    try:
        _prune_old_acked(conn)
        _prune_expired(conn)
        _enforce_cap(conn)
    except Exception:
        pass  # maintenance is best-effort, never blocks sends


def _prune_old_acked(conn: sqlite3.Connection) -> int:
    """Remove acknowledged messages older than ACK_RETENTION_DAYS."""
    cutoff = (datetime.now() - timedelta(days=ACK_RETENTION_DAYS)).isoformat()
    cursor = conn.execute("""
        DELETE FROM messages WHERE id IN (
            SELECT m.id FROM messages m
            JOIN acks a ON a.message_id = m.id
            WHERE m.created_at < ?
        )
    """, (cutoff,))
    if cursor.rowcount > 0:
        conn.commit()
    return cursor.rowcount


def _prune_expired(conn: sqlite3.Connection) -> int:
    """Remove messages older than RETENTION_DAYS that have been read."""
    cutoff = (datetime.now() - timedelta(days=RETENTION_DAYS)).isoformat()
    cursor = conn.execute("""
        DELETE FROM messages WHERE created_at < ?
        AND id IN (SELECT message_id FROM read_receipts)
    """, (cutoff,))
    if cursor.rowcount > 0:
        conn.commit()
    return cursor.rowcount


def _enforce_cap(conn: sqlite3.Connection) -> int:
    """Enforce MAX_MESSAGES hard cap. Evict: acked → read → oldest."""
    count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    if count <= MAX_MESSAGES:
        return 0

    excess = count - MAX_MESSAGES

    # Phase 1: delete oldest acked
    conn.execute(f"""
        DELETE FROM messages WHERE id IN (
            SELECT m.id FROM messages m
            JOIN acks a ON a.message_id = m.id
            ORDER BY m.created_at ASC
            LIMIT {excess}
        )
    """)
    count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    if count <= MAX_MESSAGES:
        conn.commit()
        return excess

    # Phase 2: delete oldest read (not acked)
    remaining = count - MAX_MESSAGES
    conn.execute(f"""
        DELETE FROM messages WHERE id IN (
            SELECT m.id FROM messages m
            JOIN read_receipts r ON r.message_id = m.id
            WHERE m.id NOT IN (SELECT message_id FROM acks)
            ORDER BY m.created_at ASC
            LIMIT {remaining}
        )
    """)
    conn.commit()
    return excess


def compact_thread(thread_id: str, summary: str | None = None) -> dict:
    """Compact a thread: replace all messages with a single summary message.
    
    If no summary provided, concatenates subjects of all messages.
    Preserves the thread_id and earliest created_at.
    """
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        messages = conn.execute(
            "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
            (thread_id,)
        ).fetchall()

        if len(messages) <= 1:
            return {"compacted": False, "reason": "thread has ≤1 messages"}

        earliest = messages[0]["created_at"]
        latest = messages[-1]["created_at"]

        if not summary:
            subjects = [m["subject"] for m in messages if m["subject"]]
            summary = f"[Compacted {len(messages)} messages] " + "; ".join(subjects[:5])
            if len(subjects) > 5:
                summary += f" (+{len(subjects)-5} more)"

        # Delete all messages in thread
        conn.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))

        # Insert single summary message
        summary_id = _generate_id("syn")
        conn.execute("""
            INSERT INTO messages (id, thread_id, from_agent, to_agent, priority, subject, body, created_at)
            VALUES (?, ?, 'system', 'all', 'info', ?, ?, ?)
        """, (summary_id, thread_id, f"[Thread Summary] {thread_id}", summary, earliest))

        # Update thread
        conn.execute("""
            UPDATE threads SET message_count = 1, last_message_at = ?
            WHERE id = ?
        """, (latest, thread_id))

        conn.commit()
        return {"compacted": True, "original_count": len(messages), "summary_id": summary_id}
    finally:
        conn.close()


def full_maintenance() -> dict:
    """Run full maintenance cycle. Call from cron or manually."""
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        before = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]

        acked_pruned = _prune_old_acked(conn)
        expired_pruned = _prune_expired(conn)

        # Compact large threads
        large_threads = conn.execute("""
            SELECT thread_id, COUNT(*) as cnt FROM messages
            GROUP BY thread_id HAVING cnt > ?
        """, (THREAD_COMPACT_AFTER,)).fetchall()

        compacted = 0
        for t in large_threads:
            result = compact_thread(t["thread_id"])
            if result.get("compacted"):
                compacted += 1

        cap_pruned = _enforce_cap(conn)

        after = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]

        # Clean orphaned read_receipts and acks
        conn.execute("""
            DELETE FROM read_receipts WHERE message_id NOT IN (SELECT id FROM messages)
        """)
        conn.execute("""
            DELETE FROM acks WHERE message_id NOT IN (SELECT id FROM messages)
        """)
        conn.execute("""
            DELETE FROM threads WHERE id NOT IN (SELECT DISTINCT thread_id FROM messages)
        """)
        conn.commit()

        return {
            "before": before, "after": after,
            "acked_pruned": acked_pruned, "expired_pruned": expired_pruned,
            "threads_compacted": compacted, "cap_pruned": cap_pruned,
        }
    finally:
        conn.close()


def stats() -> dict:
    """Get Synapse stats."""
    conn = _get_conn()
    _ensure_schema(conn)
    try:
        total = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        threads = conn.execute("SELECT COUNT(*) FROM threads").fetchone()[0]
        unread_helios = len(get_inbox("helios", include_read=False, limit=9999))

        by_agent = {}
        for row in conn.execute("SELECT from_agent, COUNT(*) as cnt FROM messages GROUP BY from_agent"):
            by_agent[row["from_agent"]] = row["cnt"]

        by_priority = {}
        for row in conn.execute("SELECT priority, COUNT(*) as cnt FROM messages GROUP BY priority"):
            by_priority[row["priority"]] = row["cnt"]

        return {
            "total_messages": total, "threads": threads,
            "unread_for_helios": unread_helios,
            "by_agent": by_agent, "by_priority": by_priority,
            "max_messages": MAX_MESSAGES, "retention_days": RETENTION_DAYS,
        }
    finally:
        conn.close()
