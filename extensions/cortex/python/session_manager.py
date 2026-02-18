#!/usr/bin/env python3
"""
Session Manager — Python DB layer for cross-session state persistence.
Operates on brain.db session_states table.
"""
import json
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

_DEFAULT_DATA_DIR = Path.home() / ".openclaw" / "workspace" / "memory"
DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", _DEFAULT_DATA_DIR))
DB_PATH = DATA_DIR / "brain.db"


class SessionManager:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or str(DB_PATH)
        self._ensure_table()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_table(self):
        conn = self._conn()
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS session_states (
                id TEXT PRIMARY KEY,
                start_time TEXT NOT NULL,
                end_time TEXT,
                channel TEXT DEFAULT 'unknown',
                working_memory TEXT NOT NULL DEFAULT '[]',
                hot_topics TEXT NOT NULL DEFAULT '[]',
                active_projects TEXT NOT NULL DEFAULT '[]',
                pending_tasks TEXT NOT NULL DEFAULT '[]',
                recent_learnings TEXT NOT NULL DEFAULT '[]',
                confidence_updates TEXT NOT NULL DEFAULT '[]',
                sop_interactions TEXT NOT NULL DEFAULT '[]',
                previous_session_id TEXT,
                continued_by TEXT,
                crash_recovered INTEGER DEFAULT 0,
                schema_version INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_session_endtime
                ON session_states(end_time, start_time)
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_session_prev
                ON session_states(previous_session_id)
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_session_channel
                ON session_states(channel, start_time)
        """)
        conn.commit()
        conn.close()

    def save_session(self, session: Dict[str, Any]) -> None:
        """UPSERT session record."""
        conn = self._conn()
        now = datetime.now().isoformat()
        conn.execute("""
            INSERT OR REPLACE INTO session_states (
                id, start_time, end_time, channel,
                working_memory, hot_topics, active_projects, pending_tasks,
                recent_learnings, confidence_updates, sop_interactions,
                previous_session_id, continued_by, crash_recovered,
                schema_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session["session_id"],
            session.get("start_time", now),
            session.get("end_time"),
            session.get("channel", "unknown"),
            json.dumps(session.get("working_memory", [])),
            json.dumps(session.get("hot_topics", [])),
            json.dumps(session.get("active_projects", [])),
            json.dumps(session.get("pending_tasks", [])),
            json.dumps(session.get("recent_learnings", [])),
            json.dumps(session.get("confidence_updates", [])),
            json.dumps(session.get("sop_interactions", [])),
            session.get("previous_session_id"),
            session.get("continued_by"),
            1 if session.get("crash_recovered") else 0,
            session.get("schema_version", 1),
            session.get("created_at", now),
            now,
        ))
        conn.commit()
        conn.close()

    def get_recent_sessions(self, days: int = 7, limit: int = 20) -> List[Dict[str, Any]]:
        """Get completed sessions from last N days."""
        conn = self._conn()
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        rows = conn.execute("""
            SELECT * FROM session_states
            WHERE end_time IS NOT NULL
              AND start_time >= ?
            ORDER BY end_time DESC
            LIMIT ?
        """, (cutoff, limit)).fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def get_crashed_sessions(self, active_session_id: str) -> List[Dict[str, Any]]:
        """Find sessions with NULL end_time (potential crashes)."""
        conn = self._conn()
        rows = conn.execute("""
            SELECT * FROM session_states
            WHERE end_time IS NULL
              AND id != ?
        """, (active_session_id,)).fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def mark_continued(self, session_id: str, next_id: str) -> None:
        """Update continued_by field on a prior session."""
        conn = self._conn()
        conn.execute("""
            UPDATE session_states SET continued_by = ?, updated_at = ?
            WHERE id = ?
        """, (next_id, datetime.now().isoformat(), session_id))
        conn.commit()
        conn.close()

    def recover_crashed(self, session_id: str, estimated_end_time: str) -> None:
        """Mark a crashed session as recovered."""
        conn = self._conn()
        conn.execute("""
            UPDATE session_states
            SET end_time = ?, crash_recovered = 1, updated_at = ?
            WHERE id = ?
        """, (estimated_end_time, datetime.now().isoformat(), session_id))
        conn.commit()
        conn.close()

    def get_session_chain(self, session_id: str, depth: int = 5) -> List[Dict[str, Any]]:
        """Traverse backward through session chain."""
        conn = self._conn()
        chain = []
        current_id = session_id
        for _ in range(depth):
            if not current_id:
                break
            row = conn.execute(
                "SELECT * FROM session_states WHERE id = ?", (current_id,)
            ).fetchone()
            if not row:
                break
            session = self._row_to_dict(row)
            chain.append(session)
            current_id = session.get("previous_session_id")
        conn.close()
        return chain

    def get_most_recent_session(self) -> Optional[Dict[str, Any]]:
        """Get the single most recent completed session."""
        conn = self._conn()
        row = conn.execute("""
            SELECT * FROM session_states
            WHERE end_time IS NOT NULL
            ORDER BY end_time DESC LIMIT 1
        """).fetchone()
        conn.close()
        return self._row_to_dict(row) if row else None

    def archive_old_sessions(self, days: int = 30) -> int:
        """Delete sessions older than N days. Returns count deleted."""
        conn = self._conn()
        cutoff = (datetime.now() - timedelta(days=days)).isoformat()
        c = conn.execute("""
            DELETE FROM session_states WHERE end_time < ?
        """, (cutoff,))
        count = c.rowcount
        conn.commit()
        conn.close()
        return count

    def _row_to_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        # Parse JSON fields
        for field in [
            "working_memory", "hot_topics", "active_projects", "pending_tasks",
            "recent_learnings", "confidence_updates", "sop_interactions",
        ]:
            if field in d and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    d[field] = []
        # Rename id → session_id for consistency
        d["session_id"] = d.pop("id", d.get("session_id"))
        d["crash_recovered"] = bool(d.get("crash_recovered", 0))
        return d


if __name__ == "__main__":
    import sys
    sm = SessionManager()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"

    if cmd == "recent":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
        sessions = sm.get_recent_sessions(days)
        print(json.dumps(sessions, indent=2))
    elif cmd == "chain":
        sid = sys.argv[2] if len(sys.argv) > 2 else ""
        chain = sm.get_session_chain(sid)
        print(json.dumps(chain, indent=2))
    else:
        print("Usage: session_manager.py [recent|chain] [args]")
