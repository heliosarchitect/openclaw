#!/usr/bin/env python3
"""
MCP integration smoke tests for brain.db tools.

Tests the four core MCP tool operations (remember, search, create_atom, send)
against an isolated /tmp database, then sends the result to SYNAPSE on the
production brain.db.

Usage:
    python3 extensions/cortex/python/test_mcp_integration.py
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

# Add cortex python dir to path
SCRIPT_DIR = Path(__file__).parent.resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from brain import UnifiedBrain

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TEST_DB_DIR = Path("/tmp/mcp_test")
TEST_DB = TEST_DB_DIR / "brain.db"
PROD_DATA_DIR = Path(
    os.environ.get("CORTEX_DATA_DIR", Path.home() / ".openclaw" / "workspace" / "memory")
)


def cleanup():
    if TEST_DB_DIR.exists():
        shutil.rmtree(TEST_DB_DIR)


def main():
    cleanup()
    TEST_DB_DIR.mkdir(parents=True, exist_ok=True)

    results = {}
    passed = 0
    failed = 0

    # ----- Test 1: remember (STM) -----
    test = "remember"
    try:
        brain = UnifiedBrain(str(TEST_DB))
        mem_id = brain.remember(
            "MCP integration test memory",
            categories=["test", "integration"],
            importance=2.0,
            source="test_mcp_integration",
        )
        assert mem_id.startswith("stm_"), f"Expected stm_ prefix, got {mem_id}"

        stm = brain.get_stm(limit=1)
        assert len(stm) == 1, f"Expected 1 STM entry, got {len(stm)}"
        assert stm[0]["content"] == "MCP integration test memory"
        assert stm[0]["importance"] == 2.0

        results[test] = {"status": "PASS", "memory_id": mem_id}
        passed += 1
        print(f"  PASS  {test}: {mem_id}")
    except Exception as e:
        results[test] = {"status": "FAIL", "error": str(e)}
        failed += 1
        print(f"  FAIL  {test}: {e}")

    # ----- Test 2: unified_search (FTS5) -----
    test = "search"
    try:
        brain = UnifiedBrain(str(TEST_DB))
        # Add a searchable memory
        unique_token = f"quasar_{int(time.time())}"
        brain.remember(f"The {unique_token} phenomenon is notable", categories=["test"])

        hits = brain.unified_search(unique_token, types=["stm"])
        assert len(hits) >= 1, f"Expected >=1 hit for '{unique_token}', got {len(hits)}"
        assert unique_token in hits[0].get("content", "")

        results[test] = {"status": "PASS", "hits": len(hits), "token": unique_token}
        passed += 1
        print(f"  PASS  {test}: {len(hits)} hit(s) for '{unique_token}'")
    except Exception as e:
        results[test] = {"status": "FAIL", "error": str(e)}
        failed += 1
        print(f"  FAIL  {test}: {e}")

    # ----- Test 3: create_atom -----
    test = "create_atom"
    try:
        brain = UnifiedBrain(str(TEST_DB))
        atom_id = brain.create_atom(
            subject="MCP integration test",
            action="validates",
            outcome="brain.db tools work correctly",
            consequences="confidence in deployment",
            confidence=0.95,
            source="test_mcp_integration",
        )
        assert atom_id.startswith("atm_"), f"Expected atm_ prefix, got {atom_id}"

        atom = brain.get_atom(atom_id)
        assert atom is not None, "Atom not found after create"
        assert atom["subject"] == "MCP integration test"
        assert atom["confidence"] == 0.95

        # Verify FTS works for atoms
        atom_hits = brain.unified_search("validates", types=["atom"])
        assert len(atom_hits) >= 1, "Atom FTS search returned no results"

        results[test] = {"status": "PASS", "atom_id": atom_id}
        passed += 1
        print(f"  PASS  {test}: {atom_id}")
    except Exception as e:
        results[test] = {"status": "FAIL", "error": str(e)}
        failed += 1
        print(f"  FAIL  {test}: {e}")

    # ----- Test 4: send (SYNAPSE) -----
    test = "send"
    try:
        brain = UnifiedBrain(str(TEST_DB))
        msg = brain.send(
            from_agent="test-runner",
            to_agent="claude-code",
            subject="MCP smoke test",
            body="All four core operations exercised against /tmp/mcp_test/brain.db",
            priority="info",
        )
        assert msg["id"].startswith("syn_"), f"Expected syn_ prefix, got {msg['id']}"
        assert msg["thread_id"].startswith("thr_")

        # Verify inbox delivery
        inbox = brain.inbox("claude-code")
        assert any(m["id"] == msg["id"] for m in inbox), "Message not in inbox"

        results[test] = {
            "status": "PASS",
            "message_id": msg["id"],
            "thread_id": msg["thread_id"],
        }
        passed += 1
        print(f"  PASS  {test}: {msg['id']} -> thread {msg['thread_id']}")
    except Exception as e:
        results[test] = {"status": "FAIL", "error": str(e)}
        failed += 1
        print(f"  FAIL  {test}: {e}")

    # ----- Test 5: cross-type unified search -----
    test = "unified_search_cross_type"
    try:
        brain = UnifiedBrain(str(TEST_DB))
        xtoken = f"crosscheck_{int(time.time())}"
        brain.remember(f"STM {xtoken}", categories=["test"])
        brain.send("a", "b", f"Msg {xtoken}", f"Body {xtoken}")
        brain.create_atom(xtoken, "tested", "found", "verified")

        hits = brain.unified_search(xtoken)
        types_found = {h["source_type"] for h in hits}
        assert len(types_found) >= 2, f"Expected >=2 types, got {types_found}"

        results[test] = {"status": "PASS", "types": sorted(types_found), "hits": len(hits)}
        passed += 1
        print(f"  PASS  {test}: {len(hits)} hits across {sorted(types_found)}")
    except Exception as e:
        results[test] = {"status": "FAIL", "error": str(e)}
        failed += 1
        print(f"  FAIL  {test}: {e}")

    # ----- Test 6: stats -----
    test = "stats"
    try:
        brain = UnifiedBrain(str(TEST_DB))
        s = brain.stats()
        assert s["messages"] > 0, "Expected messages > 0"
        assert s["stm_entries"] > 0, "Expected stm > 0"
        assert s["atoms"] > 0, "Expected atoms > 0"

        results[test] = {"status": "PASS", "stats": s}
        passed += 1
        print(f"  PASS  {test}: {s['messages']} msgs, {s['stm_entries']} stm, {s['atoms']} atoms")
    except Exception as e:
        results[test] = {"status": "FAIL", "error": str(e)}
        failed += 1
        print(f"  FAIL  {test}: {e}")

    # ----- Summary -----
    total = passed + failed
    print(f"\n{'='*50}")
    print(f"  Results: {passed}/{total} passed", end="")
    if failed > 0:
        print(f" ({failed} FAILED)")
    else:
        print(" — all green")
    print(f"  Test DB: {TEST_DB}")

    # ----- Send result to production SYNAPSE -----
    prod_db = PROD_DATA_DIR / "brain.db"
    if prod_db.exists():
        try:
            prod_brain = UnifiedBrain(str(prod_db))
            summary = f"{passed}/{total} passed"
            if failed > 0:
                summary += f" ({failed} FAILED: {', '.join(k for k, v in results.items() if v['status'] == 'FAIL')})"
            else:
                summary += " — all green"

            msg = prod_brain.send(
                from_agent="claude-code",
                to_agent="helios",
                subject="MCP integration smoke test results",
                body=(
                    f"Ran {total} brain.db MCP tool smoke tests.\n\n"
                    f"Result: {summary}\n\n"
                    f"Tests: remember, search, create_atom, send, unified_search_cross_type, stats\n"
                    f"DB: {TEST_DB}\n\n"
                    f"Details:\n{json.dumps(results, indent=2, default=str)}"
                ),
                priority="info",
            )
            print(f"  SYNAPSE: sent results to helios ({msg['id']})")
        except Exception as e:
            print(f"  SYNAPSE: failed to send results — {e}")
    else:
        print(f"  SYNAPSE: skipped (no prod DB at {prod_db})")

    # Cleanup
    cleanup()

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    print("MCP Integration Smoke Tests")
    print("=" * 50)
    sys.exit(main())
