"""Tests for memory_consolidation_rules.py"""

import json
import sqlite3
from datetime import datetime, timedelta

import numpy as np
import pytest

from brain import UnifiedBrain
from memory_consolidation_rules import (
    _parse_categories,
    detect_contradictions,
    execute_actions,
    plan_actions,
)


def _unit_vec(seed: int, dim: int = 64) -> np.ndarray:
    rng = np.random.default_rng(seed)
    v = rng.normal(size=dim).astype(np.float32)
    return v / np.linalg.norm(v)


@pytest.fixture
def brain(tmp_path):
    return UnifiedBrain(str(tmp_path / "test.db"))


class TestHelpers:
    def test_parse_categories_handles_json_and_list(self):
        assert _parse_categories('["a","b"]') == ["a", "b"]
        assert _parse_categories(["x", "y"]) == ["x", "y"]
        assert _parse_categories("not-json") == []


class TestPlanning:
    def test_plan_actions_emits_merge_promote_archive(self):
        now = datetime.now()
        v1 = _unit_vec(1)
        v2 = _unit_vec(2)

        entries = [
            {
                "id": "stm_a",
                "content": "process says use 5 retries",
                "categories": ["coding", "procedure"],
                "importance": 2.1,
                "created_at": now.isoformat(),
                "access_count": 6,
                "source": "agent",
                "embedding": v1,
                "norm": "process says use 5 retries",
            },
            {
                "id": "stm_b",
                "content": "process says use 5 retries always",
                "categories": ["coding"],
                "importance": 2.0,
                "created_at": (now - timedelta(minutes=1)).isoformat(),
                "access_count": 7,
                "source": "agent",
                "embedding": v1.copy(),
                "norm": "process says use 5 retries always",
            },
            {
                "id": "stm_old",
                "content": "stale note",
                "categories": ["general"],
                "importance": 1.0,
                "created_at": (now - timedelta(days=45)).isoformat(),
                "access_count": 0,
                "source": "agent",
                "embedding": v2,
                "norm": "stale note",
            },
        ]

        actions, counts, _ = plan_actions(entries, similarity_threshold=0.95)

        assert counts.get("merge", 0) == 1
        assert counts.get("promote", 0) >= 1
        assert counts.get("archive", 0) == 1
        assert any(a["type"] == "merge" and len(a["targetIds"]) == 2 for a in actions)

    def test_detect_contradictions_negation_and_numeric_mismatch(self):
        v = _unit_vec(5)
        cluster = [
            {
                "id": "stm_yes",
                "norm": "system allows 3 retries",
                "embedding": v,
            },
            {
                "id": "stm_no",
                "norm": "system does not allow 5 retries",
                "embedding": v.copy(),
            },
        ]

        findings = detect_contradictions(cluster, similarity_threshold=0.9)
        assert len(findings) == 1
        assert findings[0]["signals"]["negation_asymmetry"] is True
        assert findings[0]["signals"]["numeric_mismatch"] is True


class TestExecution:
    def test_execute_flag_contradiction_is_idempotent(self, brain):
        db = str(brain.db_path)
        now = datetime.now().isoformat()
        conn = sqlite3.connect(db)
        conn.execute(
            "INSERT INTO stm (id, content, categories, importance, access_count, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("stm_1", "A", json.dumps(["test"]), 1.0, 0, now, "agent"),
        )
        conn.execute(
            "INSERT INTO stm (id, content, categories, importance, access_count, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("stm_2", "B", json.dumps(["test"]), 1.0, 0, now, "agent"),
        )
        conn.commit()
        conn.close()

        actions = [
            {
                "type": "flag_contradiction",
                "targetIds": ["stm_1", "stm_2"],
                "rationale": {"evidence": {"kind": "test"}},
            }
        ]

        first = execute_actions(db, actions, "run-1")
        second = execute_actions(db, actions, "run-2")

        assert first.get("flag_contradiction", 0) == 1
        assert second.get("flag_contradiction", 0) == 0

        conn = sqlite3.connect(db)
        count = conn.execute(
            "SELECT COUNT(*) FROM stm WHERE source LIKE 'consolidation:contradiction:%'"
        ).fetchone()[0]
        conn.close()
        assert count == 1
