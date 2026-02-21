#!/usr/bin/env python3
"""
Rule-driven Memory Consolidation for Cortex (Phase 2.2 build stage).

Default mode is dry-run. Execution applies transactional updates to brain.db.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import sqlite3
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

NEGATION_MARKERS = {"not", "never", "cannot", "can't", "wont", "won't", "avoid", "do not", "must not"}
PROCEDURAL_CATEGORIES = {"sop", "procedure", "coding", "trading"}


def _now() -> str:
    return datetime.now().isoformat()


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def _blob_to_vec(blob: bytes | None) -> np.ndarray | None:
    if blob is None:
        return None
    return np.frombuffer(blob, dtype=np.float32)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_categories(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(x) for x in raw]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except json.JSONDecodeError:
            pass
    return []


def load_stm_with_embeddings(db_path: str) -> list[dict[str, Any]]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT s.id, s.content, s.categories, s.importance, s.created_at, s.access_count, s.source,
               e.embedding
          FROM stm s
          JOIN embeddings e ON e.source_type='stm' AND e.source_id=s.id
         ORDER BY s.created_at DESC, s.id DESC
        """
    ).fetchall()
    conn.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        vec = _blob_to_vec(r["embedding"])
        if vec is None:
            continue
        out.append({
            "id": r["id"],
            "content": r["content"],
            "categories": _parse_categories(r["categories"]),
            "importance": float(r["importance"] or 1.0),
            "created_at": r["created_at"],
            "access_count": int(r["access_count"] or 0),
            "source": r["source"] or "agent",
            "embedding": vec,
            "norm": _normalize(r["content"] or ""),
        })
    return out


def cluster_entries(entries: list[dict[str, Any]], threshold: float = 0.95) -> list[list[dict[str, Any]]]:
    assigned = [False] * len(entries)
    clusters: list[list[dict[str, Any]]] = []
    for i, base in enumerate(entries):
        if assigned[i]:
            continue
        cluster = [base]
        assigned[i] = True
        for j in range(i + 1, len(entries)):
            if assigned[j]:
                continue
            cand = entries[j]
            if all(_cosine(cand["embedding"], m["embedding"]) >= threshold for m in cluster):
                cluster.append(cand)
                assigned[j] = True
        clusters.append(cluster)
    return clusters


def detect_contradictions(cluster: list[dict[str, Any]], similarity_threshold: float = 0.9) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for i in range(len(cluster)):
        for j in range(i + 1, len(cluster)):
            a, b = cluster[i], cluster[j]
            sim = _cosine(a["embedding"], b["embedding"])
            if sim < similarity_threshold:
                continue
            ta, tb = a["norm"], b["norm"]
            markers_a = [m for m in NEGATION_MARKERS if m in ta]
            markers_b = [m for m in NEGATION_MARKERS if m in tb]
            nums_a = set(re.findall(r"\d+(?:\.\d+)?", ta))
            nums_b = set(re.findall(r"\d+(?:\.\d+)?", tb))
            numeric_mismatch = bool(nums_a.symmetric_difference(nums_b))
            negation_asym = bool(markers_a) ^ bool(markers_b)
            if negation_asym or numeric_mismatch:
                findings.append({
                    "a": a["id"],
                    "b": b["id"],
                    "similarity": sim,
                    "signals": {
                        "negation_asymmetry": negation_asym,
                        "numeric_mismatch": numeric_mismatch,
                        "markers_a": markers_a,
                        "markers_b": markers_b,
                    },
                })
    return findings


def plan_actions(entries: list[dict[str, Any]], similarity_threshold: float = 0.95) -> tuple[list[dict[str, Any]], dict[str, int], int]:
    actions: list[dict[str, Any]] = []
    clusters = cluster_entries(entries, threshold=similarity_threshold)
    contradiction_pairs = 0

    for idx, c in enumerate(clusters):
        cluster_id = f"cluster_{idx:04d}"
        if len(c) >= 2:
            sorted_newest = sorted(c, key=lambda x: (x["created_at"] or "", x["id"]), reverse=True)
            canonical = sorted_newest[0]
            actions.append({
                "type": "merge",
                "targetIds": [x["id"] for x in c],
                "canonicalId": canonical["id"],
                "rationale": {
                    "ruleId": "R2-near-duplicate-merge",
                    "reasons": ["cluster_size >= 2", f"similarity >= {similarity_threshold}"],
                    "evidence": {"clusterId": cluster_id},
                },
            })

        for e in c:
            categories = {x.lower() for x in e["categories"]}
            if e["access_count"] >= 5 and e["importance"] >= 2.0 and categories.intersection(PROCEDURAL_CATEGORIES):
                actions.append({
                    "type": "promote",
                    "targetIds": [e["id"]],
                    "newImportance": min(e["importance"] + 0.5, 3.0),
                    "rationale": {
                        "ruleId": "R3-promote-high-value-procedural",
                        "reasons": ["access_count >= 5", "importance >= 2.0", "procedural category"],
                        "evidence": {"clusterId": cluster_id},
                    },
                })

            try:
                age_days = (datetime.now() - datetime.fromisoformat(e["created_at"])).days
            except Exception:
                age_days = 0
            if age_days >= 30 and e["access_count"] == 0 and e["importance"] <= 1.5:
                actions.append({
                    "type": "archive",
                    "targetIds": [e["id"]],
                    "rationale": {
                        "ruleId": "R4-archive-low-utility",
                        "reasons": ["age >= 30d", "access_count == 0", "importance <= 1.5"],
                        "evidence": {"clusterId": cluster_id},
                    },
                })

        contradictions = detect_contradictions(c)
        contradiction_pairs += len(contradictions)
        for pair in contradictions:
            actions.append({
                "type": "flag_contradiction",
                "targetIds": [pair["a"], pair["b"]],
                "rationale": {
                    "ruleId": "R5-flag-contradiction",
                    "reasons": ["high semantic similarity with conflict signals"],
                    "evidence": {
                        "clusterId": cluster_id,
                        "similarity": round(pair["similarity"], 4),
                        "contradictionSignals": pair["signals"],
                    },
                },
            })

    counts = Counter(a["type"] for a in actions)
    return actions, dict(counts), contradiction_pairs


def execute_actions(db_path: str, actions: list[dict[str, Any]], run_id: str) -> dict[str, int]:
    executed = Counter()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        for action in actions:
            t = action["type"]
            ids = action.get("targetIds", [])
            if t == "merge" and len(ids) >= 2:
                canonical = action["canonicalId"]
                rows = conn.execute(
                    f"SELECT id, categories, importance, access_count, source FROM stm WHERE id IN ({','.join('?'*len(ids))})",
                    ids,
                ).fetchall()
                if not rows:
                    continue
                merged_cats = set()
                total_access = 0
                max_importance = 1.0
                for r in rows:
                    merged_cats.update(_parse_categories(r["categories"]))
                    total_access += int(r["access_count"] or 0)
                    max_importance = max(max_importance, float(r["importance"] or 1.0))
                source_meta = json.dumps({"merged_from": ids, "run_id": run_id, "at": _now()})
                conn.execute(
                    "UPDATE stm SET categories=?, importance=?, access_count=?, source=?, updated_at=? WHERE id=?",
                    (json.dumps(sorted(merged_cats or {"consolidated"})), max_importance, total_access, f"consolidation:{source_meta}", _now(), canonical),
                )
                for mid in [x for x in ids if x != canonical]:
                    cur = conn.execute("SELECT categories FROM stm WHERE id=?", (mid,)).fetchone()
                    if not cur:
                        continue
                    cats = set(_parse_categories(cur["categories"]))
                    cats.add("archived")
                    conn.execute(
                        "UPDATE stm SET categories=?, source=?, updated_at=? WHERE id=?",
                        (json.dumps(sorted(cats)), f"archived:merged_into:{canonical}", _now(), mid),
                    )
                executed[t] += 1
            elif t == "promote" and ids:
                conn.execute("UPDATE stm SET importance=?, updated_at=? WHERE id=?", (action["newImportance"], _now(), ids[0]))
                executed[t] += 1
            elif t == "archive" and ids:
                row = conn.execute("SELECT categories FROM stm WHERE id=?", (ids[0],)).fetchone()
                if row:
                    cats = set(_parse_categories(row["categories"]))
                    cats.add("archived")
                    conn.execute(
                        "UPDATE stm SET categories=?, source=?, updated_at=? WHERE id=?",
                        (json.dumps(sorted(cats)), "archived:low_utility", _now(), ids[0]),
                    )
                    executed[t] += 1
            elif t == "flag_contradiction" and len(ids) == 2:
                key = hashlib.sha256("|".join(sorted(ids)).encode()).hexdigest()[:16]
                existing = conn.execute("SELECT 1 FROM stm WHERE source=? LIMIT 1", (f"consolidation:contradiction:{key}",)).fetchone()
                if existing:
                    continue
                content = json.dumps({"type": "contradiction", "ids": sorted(ids), "evidence": action["rationale"]["evidence"], "run_id": run_id})
                conn.execute(
                    "INSERT INTO stm (id, content, categories, importance, access_count, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (_gen_id("stm"), content, json.dumps(["contradictions", "consolidation"]), 2.0, 0, _now(), _now(), f"consolidation:contradiction:{key}"),
                )
                executed[t] += 1
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return dict(executed)


def run(db_path: str, dry_run: bool = True, similarity_threshold: float = 0.95, report_path: str | None = None) -> dict[str, Any]:
    entries = load_stm_with_embeddings(db_path)
    actions, planned_counts, contradiction_pairs = plan_actions(entries, similarity_threshold=similarity_threshold)

    run_id = _now()
    report: dict[str, Any] = {
        "run_id": run_id,
        "mode": "dry_run" if dry_run else "execute",
        "config_hash": "sha256:" + hashlib.sha256(json.dumps({"similarity_threshold": similarity_threshold}, sort_keys=True).encode()).hexdigest(),
        "scope": {"limit": None},
        "detected": {"clusters": len(cluster_entries(entries, similarity_threshold)), "contradiction_pairs": contradiction_pairs},
        "planned": {
            "merge": planned_counts.get("merge", 0),
            "promote": planned_counts.get("promote", 0),
            "archive": planned_counts.get("archive", 0),
            "flag_contradiction": planned_counts.get("flag_contradiction", 0),
            "noop": 0,
        },
        "actions": actions,
        "executed": {},
    }

    if not dry_run:
        report["executed"] = execute_actions(db_path, actions, run_id)

    if report_path:
        rp = Path(report_path)
        rp.parent.mkdir(parents=True, exist_ok=True)
        rp.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Rule-driven Cortex memory consolidation")
    parser.add_argument("--db", required=True, help="Path to brain.db")
    parser.add_argument("--execute", action="store_true", help="Apply planned actions (default dry-run)")
    parser.add_argument("--threshold", type=float, default=0.95, help="Similarity threshold")
    parser.add_argument("--report", default=None, help="JSON report output path")
    args = parser.parse_args()

    report = run(db_path=args.db, dry_run=not args.execute, similarity_threshold=args.threshold, report_path=args.report)
    print(json.dumps({
        "run_id": report["run_id"],
        "mode": report["mode"],
        "planned": report["planned"],
        "executed": report.get("executed", {}),
    }, indent=2))


if __name__ == "__main__":
    main()
