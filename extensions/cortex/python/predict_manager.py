#!/usr/bin/env python3
"""
Predict Manager — Python DB layer for predictive intent insights.
Operates on brain.db insights, insight_feedback, and predict_action_rates tables.
Schema migration v5.
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


class PredictManager:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or str(DB_PATH)
        self._ensure_tables()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_tables(self):
        conn = self._conn()
        c = conn.cursor()

        c.execute("""
            CREATE TABLE IF NOT EXISTS insights (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                urgency TEXT NOT NULL,
                urgency_score REAL NOT NULL,
                confidence REAL NOT NULL DEFAULT 0.8,
                actionable INTEGER NOT NULL DEFAULT 1,
                expires_at TEXT,
                generated_at TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'generated',
                delivery_channel TEXT,
                delivered_at TEXT,
                session_id TEXT NOT NULL,
                schema_version INTEGER DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT
            )
        """)

        c.execute("CREATE INDEX IF NOT EXISTS idx_insights_state ON insights(state, urgency_score DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_insights_source ON insights(source_id, type, generated_at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_insights_expires ON insights(expires_at, state)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_insights_session ON insights(session_id, generated_at DESC)")

        c.execute("""
            CREATE TABLE IF NOT EXISTS insight_feedback (
                id TEXT PRIMARY KEY,
                insight_id TEXT NOT NULL,
                insight_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                urgency_at_delivery TEXT NOT NULL,
                delivered_at TEXT NOT NULL,
                channel TEXT NOT NULL,
                acted_on INTEGER NOT NULL DEFAULT 0,
                action_type TEXT NOT NULL DEFAULT 'ignored',
                latency_ms INTEGER,
                session_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        c.execute("CREATE INDEX IF NOT EXISTS idx_feedback_source_type ON insight_feedback(source_id, insight_type, acted_on)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_feedback_insight ON insight_feedback(insight_id)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_feedback_session ON insight_feedback(session_id, created_at DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_feedback_window ON insight_feedback(created_at DESC)")

        c.execute("""
            CREATE TABLE IF NOT EXISTS predict_action_rates (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                insight_type TEXT NOT NULL,
                action_rate REAL NOT NULL DEFAULT 0.0,
                observation_count INTEGER DEFAULT 0,
                rate_halved INTEGER DEFAULT 0,
                last_updated TEXT NOT NULL,
                UNIQUE(source_id, insight_type)
            )
        """)

        conn.commit()
        conn.close()

    def save_insight(self, insight: Dict[str, Any]) -> None:
        conn = self._conn()
        now = datetime.now().isoformat()
        conn.execute("""
            INSERT OR REPLACE INTO insights (
                id, type, source_id, title, body, urgency, urgency_score,
                confidence, actionable, expires_at, generated_at, state,
                delivery_channel, delivered_at, session_id, schema_version,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            insight["id"], insight["type"], insight["source_id"],
            insight["title"], insight["body"], insight["urgency"],
            insight["urgency_score"], insight.get("confidence", 0.8),
            1 if insight.get("actionable", True) else 0,
            insight.get("expires_at"), insight["generated_at"],
            insight.get("state", "generated"), insight.get("delivery_channel"),
            insight.get("delivered_at"), insight["session_id"],
            insight.get("schema_version", 1), now, now,
        ))
        conn.commit()
        conn.close()

    def update_insight_state(self, insight_id: str, state: str, extra: Optional[Dict] = None) -> None:
        conn = self._conn()
        now = datetime.now().isoformat()
        if extra:
            sets = ", ".join(f"{k} = ?" for k in extra.keys())
            vals = list(extra.values()) + [now, insight_id]
            conn.execute(
                f"UPDATE insights SET state = ?, {sets}, updated_at = ? WHERE id = ?",
                [state] + list(extra.values()) + [now, insight_id],
            )
        else:
            conn.execute(
                "UPDATE insights SET state = ?, updated_at = ? WHERE id = ?",
                (state, now, insight_id),
            )
        conn.commit()
        conn.close()

    def get_queued_insights(self) -> List[Dict]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM insights WHERE state IN ('queued', 'scored') ORDER BY urgency_score DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def save_feedback(self, feedback: Dict[str, Any]) -> None:
        conn = self._conn()
        conn.execute("""
            INSERT INTO insight_feedback (
                id, insight_id, insight_type, source_id, urgency_at_delivery,
                delivered_at, channel, acted_on, action_type, latency_ms,
                session_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            feedback["id"], feedback["insight_id"], feedback["insight_type"],
            feedback["source_id"], feedback["urgency_at_delivery"],
            feedback["delivered_at"], feedback["channel"],
            1 if feedback.get("acted_on", False) else 0,
            feedback.get("action_type", "ignored"),
            feedback.get("latency_ms"), feedback["session_id"],
            feedback.get("created_at", datetime.now().isoformat()),
        ))
        conn.commit()
        conn.close()

    def get_action_rate(self, source_id: str, insight_type: str) -> Dict:
        conn = self._conn()
        row = conn.execute(
            "SELECT * FROM predict_action_rates WHERE source_id = ? AND insight_type = ?",
            (source_id, insight_type),
        ).fetchone()
        conn.close()
        if row:
            return dict(row)
        return {
            "id": f"{source_id}::{insight_type}",
            "source_id": source_id,
            "insight_type": insight_type,
            "action_rate": 0.5,  # Default prior
            "observation_count": 0,
            "rate_halved": 0,
            "last_updated": datetime.now().isoformat(),
        }

    def upsert_action_rate(
        self, source_id: str, insight_type: str,
        rate: float, count: int, halved: bool,
    ) -> None:
        conn = self._conn()
        now = datetime.now().isoformat()
        rate_id = f"{source_id}::{insight_type}"
        conn.execute("""
            INSERT OR REPLACE INTO predict_action_rates (
                id, source_id, insight_type, action_rate,
                observation_count, rate_halved, last_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (rate_id, source_id, insight_type, rate, count, 1 if halved else 0, now))
        conn.commit()
        conn.close()

    def get_feedback_history(
        self, source_id: str, insight_type: str,
        acted_on: bool, window_days: int,
    ) -> List[Dict]:
        conn = self._conn()
        cutoff = (datetime.now() - timedelta(days=window_days)).isoformat()
        rows = conn.execute("""
            SELECT * FROM insight_feedback
            WHERE source_id = ? AND insight_type = ? AND acted_on = ?
              AND created_at > ?
            ORDER BY created_at DESC
        """, (source_id, insight_type, 1 if acted_on else 0, cutoff)).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_recent_delivered(self, limit: int = 10) -> List[Dict]:
        conn = self._conn()
        rows = conn.execute(
            "SELECT * FROM insights WHERE state = 'delivered' ORDER BY delivered_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def expire_stale_insights(self) -> int:
        conn = self._conn()
        now = datetime.now().isoformat()
        c = conn.execute(
            "UPDATE insights SET state = 'expired', updated_at = ? "
            "WHERE expires_at IS NOT NULL AND expires_at < ? AND state NOT IN ('expired', 'acted_on', 'ignored')",
            (now, now),
        )
        count = c.rowcount
        conn.commit()
        conn.close()
        return count


# CLI entry point for bridge calls
if __name__ == "__main__":
    import sys
    pm = PredictManager()
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""

    if cmd == "save_insight":
        data = json.loads(sys.argv[2])
        pm.save_insight(data)
        print(json.dumps({"ok": True}))
    elif cmd == "update_state":
        insight_id = sys.argv[2]
        state = sys.argv[3]
        extra = json.loads(sys.argv[4]) if len(sys.argv) > 4 else None
        pm.update_insight_state(insight_id, state, extra)
        print(json.dumps({"ok": True}))
    elif cmd == "get_queued":
        print(json.dumps(pm.get_queued_insights()))
    elif cmd == "save_feedback":
        data = json.loads(sys.argv[2])
        pm.save_feedback(data)
        print(json.dumps({"ok": True}))
    elif cmd == "get_action_rate":
        print(json.dumps(pm.get_action_rate(sys.argv[2], sys.argv[3])))
    elif cmd == "upsert_action_rate":
        pm.upsert_action_rate(
            sys.argv[2], sys.argv[3],
            float(sys.argv[4]), int(sys.argv[5]), sys.argv[6] == "true",
        )
        print(json.dumps({"ok": True}))
    elif cmd == "get_feedback_history":
        print(json.dumps(pm.get_feedback_history(
            sys.argv[2], sys.argv[3], sys.argv[4] == "true", int(sys.argv[5]),
        )))
    elif cmd == "get_recent_delivered":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        print(json.dumps(pm.get_recent_delivered(limit)))
    elif cmd == "expire_stale":
        count = pm.expire_stale_insights()
        print(json.dumps({"expired": count}))
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
