#!/usr/bin/env python3
"""
working_memory_sync.py — Bidirectional sync between working_memory.json and brain.db

OpenClaw's TypeScript reads/writes working_memory.json directly (index.ts).
brain.db has a working_memory table (brain.py).
This script keeps them in sync.

Usage:
    python3 working_memory_sync.py          # json → db (default)
    python3 working_memory_sync.py --to-json  # db → json
    python3 working_memory_sync.py --check    # show diff without syncing

Run as cron every 5 minutes or on-demand.
"""

import json
import os
import sys
from pathlib import Path

# Paths
MEMORY_DIR = Path.home() / ".openclaw" / "workspace" / "memory"
JSON_PATH = MEMORY_DIR / "working_memory.json"
DB_PATH = MEMORY_DIR / "brain.db"

# Add brain.py to path
PYTHON_DIR = Path(__file__).parent
sys.path.insert(0, str(PYTHON_DIR))


def load_json() -> list:
    """Load items from working_memory.json."""
    try:
        with open(JSON_PATH, "r") as f:
            data = json.load(f)
            return data.get("items", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def load_db() -> list:
    """Load items from brain.db working_memory table."""
    from brain import UnifiedBrain
    brain = UnifiedBrain(str(DB_PATH))
    return brain.get_working_memory()


def save_json(items: list):
    """Write items to working_memory.json in OpenClaw format."""
    json_items = []
    for item in items:
        json_items.append({
            "content": item.get("content", ""),
            "pinnedAt": item.get("pinned_at", item.get("pinnedAt", "")),
            "label": item.get("label", ""),
        })
    with open(JSON_PATH, "w") as f:
        json.dump({"items": json_items}, f, indent=2)


def sync_to_db(json_items: list):
    """Sync JSON items into brain.db (JSON is source of truth)."""
    from brain import UnifiedBrain
    brain = UnifiedBrain(str(DB_PATH))
    
    # Clear DB working memory
    brain.clear_working_memory()
    
    # Re-insert from JSON
    count = 0
    for item in json_items:
        brain.pin_working_memory(
            label=item.get("label", ""),
            content=item.get("content", ""),
        )
        count += 1
    
    return count


def sync_to_json(db_items: list):
    """Sync brain.db items to JSON (DB is source of truth)."""
    save_json(db_items)
    return len(db_items)


def items_match(json_items: list, db_items: list) -> bool:
    """Check if JSON and DB have same content (order-insensitive)."""
    json_contents = sorted(item.get("content", "") for item in json_items)
    db_contents = sorted(item.get("content", "") for item in db_items)
    return json_contents == db_contents


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Sync working memory between JSON and brain.db")
    parser.add_argument("--to-json", action="store_true", help="DB → JSON (brain.db is source)")
    parser.add_argument("--check", action="store_true", help="Show diff without syncing")
    args = parser.parse_args()

    json_items = load_json()
    db_items = load_db()

    if args.check:
        print(f"JSON: {len(json_items)} items")
        print(f"DB:   {len(db_items)} items")
        if items_match(json_items, db_items):
            print("✅ In sync")
        else:
            print("❌ Out of sync")
            json_labels = [i.get("label", "?") for i in json_items]
            db_labels = [i.get("label", "?") for i in db_items]
            print(f"  JSON labels: {json_labels}")
            print(f"  DB labels:   {db_labels}")
        return

    if args.to_json:
        count = sync_to_json(db_items)
        print(f"✅ Synced {count} items: DB → JSON")
    else:
        # Default: JSON → DB (OpenClaw TS is the writer)
        if items_match(json_items, db_items):
            print("✅ Already in sync")
        else:
            count = sync_to_db(json_items)
            print(f"✅ Synced {count} items: JSON → DB")


if __name__ == "__main__":
    main()
