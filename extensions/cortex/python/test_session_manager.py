#!/usr/bin/env python3
"""
Integration Tests — Python SessionManager
Cross-Session State Preservation v2.0.0 | task-004

Tests SQLite CRUD, chain traversal, crash recovery, archival.
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

# Add parent dir to path
sys.path.insert(0, os.path.dirname(__file__))
from session_manager import SessionManager


class TestSessionManager(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.sm = SessionManager(db_path=self.tmp.name)

    def tearDown(self):
        os.unlink(self.tmp.name)

    def _make_session(self, sid="test-001", hours_ago=1, end=True, **kwargs):
        now = datetime.now()
        return {
            "session_id": sid,
            "start_time": (now - timedelta(hours=hours_ago + 1)).isoformat(),
            "end_time": (now - timedelta(hours=hours_ago)).isoformat() if end else None,
            "channel": kwargs.get("channel", "signal"),
            "working_memory": kwargs.get("working_memory", []),
            "hot_topics": kwargs.get("hot_topics", ["augur", "trading"]),
            "active_projects": kwargs.get("active_projects", []),
            "pending_tasks": kwargs.get("pending_tasks", []),
            "recent_learnings": kwargs.get("recent_learnings", []),
            "confidence_updates": kwargs.get("confidence_updates", []),
            "sop_interactions": kwargs.get("sop_interactions", []),
            "previous_session_id": kwargs.get("previous_session_id", None),
            "continued_by": kwargs.get("continued_by", None),
            "crash_recovered": kwargs.get("crash_recovered", False),
            "schema_version": 1,
            "created_at": now.isoformat(),
        }

    # ----- Basic CRUD -----

    def test_save_and_retrieve(self):
        sess = self._make_session("sess-001")
        self.sm.save_session(sess)
        recent = self.sm.get_recent_sessions(days=7)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["session_id"], "sess-001")

    def test_upsert_overwrites(self):
        sess = self._make_session("sess-001", hot_topics=["old"])
        self.sm.save_session(sess)
        sess["hot_topics"] = ["new"]
        self.sm.save_session(sess)
        recent = self.sm.get_recent_sessions(days=7)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[0]["hot_topics"], ["new"])

    def test_json_fields_round_trip(self):
        pins = [{"content": "test", "pinnedAt": "2026-01-01", "label": "lbl"}]
        tasks = [{"task_id": "t1", "title": "T1", "stage": "build", "flagged_incomplete": True}]
        sess = self._make_session("sess-json", working_memory=pins, pending_tasks=tasks)
        self.sm.save_session(sess)
        result = self.sm.get_recent_sessions(days=7)[0]
        self.assertEqual(result["working_memory"], pins)
        self.assertEqual(result["pending_tasks"], tasks)

    # ----- Recent sessions -----

    def test_recent_excludes_active(self):
        """Sessions with NULL end_time should not appear in recent."""
        self.sm.save_session(self._make_session("active", end=False))
        self.sm.save_session(self._make_session("completed", end=True))
        recent = self.sm.get_recent_sessions(days=7)
        ids = [s["session_id"] for s in recent]
        self.assertNotIn("active", ids)
        self.assertIn("completed", ids)

    def test_recent_respects_days_limit(self):
        self.sm.save_session(self._make_session("recent", hours_ago=1))
        self.sm.save_session(self._make_session("old", hours_ago=200))  # ~8 days
        recent = self.sm.get_recent_sessions(days=7)
        ids = [s["session_id"] for s in recent]
        self.assertIn("recent", ids)
        self.assertNotIn("old", ids)

    def test_recent_respects_limit(self):
        for i in range(10):
            self.sm.save_session(self._make_session(f"sess-{i}", hours_ago=i + 1))
        recent = self.sm.get_recent_sessions(days=7, limit=3)
        self.assertEqual(len(recent), 3)

    def test_recent_ordered_by_end_time_desc(self):
        self.sm.save_session(self._make_session("old", hours_ago=5))
        self.sm.save_session(self._make_session("new", hours_ago=1))
        recent = self.sm.get_recent_sessions(days=7)
        self.assertEqual(recent[0]["session_id"], "new")

    # ----- Crash detection -----

    def test_detect_crashed(self):
        self.sm.save_session(self._make_session("crashed", end=False))
        self.sm.save_session(self._make_session("active", end=False))
        crashed = self.sm.get_crashed_sessions("active")
        ids = [s["session_id"] for s in crashed]
        self.assertIn("crashed", ids)
        self.assertNotIn("active", ids)

    def test_recover_crashed(self):
        self.sm.save_session(self._make_session("crashed", end=False))
        now = datetime.now().isoformat()
        self.sm.recover_crashed("crashed", now)
        # Should now appear in recent (has end_time)
        recent = self.sm.get_recent_sessions(days=7)
        recovered = [s for s in recent if s["session_id"] == "crashed"]
        self.assertEqual(len(recovered), 1)
        self.assertTrue(recovered[0]["crash_recovered"])

    # ----- Chain traversal -----

    def test_session_chain(self):
        self.sm.save_session(self._make_session("s1", previous_session_id=None))
        self.sm.save_session(self._make_session("s2", previous_session_id="s1"))
        self.sm.save_session(self._make_session("s3", previous_session_id="s2"))
        chain = self.sm.get_session_chain("s3", depth=10)
        ids = [s["session_id"] for s in chain]
        self.assertEqual(ids, ["s3", "s2", "s1"])

    def test_session_chain_respects_depth(self):
        self.sm.save_session(self._make_session("s1"))
        self.sm.save_session(self._make_session("s2", previous_session_id="s1"))
        self.sm.save_session(self._make_session("s3", previous_session_id="s2"))
        chain = self.sm.get_session_chain("s3", depth=2)
        self.assertEqual(len(chain), 2)

    def test_chain_handles_missing_session(self):
        chain = self.sm.get_session_chain("nonexistent")
        self.assertEqual(chain, [])

    # ----- Mark continued -----

    def test_mark_continued(self):
        self.sm.save_session(self._make_session("s1"))
        self.sm.mark_continued("s1", "s2")
        chain = self.sm.get_session_chain("s1")
        self.assertEqual(chain[0].get("continued_by"), "s2")

    # ----- Most recent session -----

    def test_get_most_recent(self):
        self.sm.save_session(self._make_session("old", hours_ago=5))
        self.sm.save_session(self._make_session("new", hours_ago=1))
        result = self.sm.get_most_recent_session()
        self.assertEqual(result["session_id"], "new")

    def test_get_most_recent_empty(self):
        result = self.sm.get_most_recent_session()
        self.assertIsNone(result)

    # ----- Archival -----

    def test_archive_old_sessions(self):
        self.sm.save_session(self._make_session("old", hours_ago=800))  # ~33 days
        self.sm.save_session(self._make_session("recent", hours_ago=1))
        deleted = self.sm.archive_old_sessions(days=30)
        self.assertEqual(deleted, 1)
        recent = self.sm.get_recent_sessions(days=365)
        ids = [s["session_id"] for s in recent]
        self.assertNotIn("old", ids)
        self.assertIn("recent", ids)

    # ----- Idempotency -----

    def test_table_creation_idempotent(self):
        """Creating SessionManager twice on same DB should not fail."""
        sm2 = SessionManager(db_path=self.tmp.name)
        sm2.save_session(self._make_session("test"))
        self.assertEqual(len(sm2.get_recent_sessions(days=7)), 1)


if __name__ == "__main__":
    unittest.main()
