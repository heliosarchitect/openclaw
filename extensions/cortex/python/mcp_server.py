#!/usr/bin/env python3
"""
Cortex MCP Server — Unified Brain Backend (v2)

Exposes 4 MCP tools (cortex, atom, temporal, synapse) backed by a single
SQLite database (brain.db). WAL mode, FTS5, unlimited history, unified search.

Same tool names and schemas as v1 — no client changes needed.

Usage:
    python3 extensions/cortex/python/mcp_server.py

Configure in .claude/mcp.json:
    {
        "mcpServers": {
            "cortex": {
                "command": "python3",
                "args": ["extensions/cortex/python/mcp_server.py"],
                "env": { "CORTEX_DATA_DIR": "~/.openclaw/workspace/memory" }
            }
        }
    }
"""
import json
import os
import sys
from pathlib import Path

# Resolve CORTEX_DATA_DIR (expand ~)
data_dir_raw = os.environ.get("CORTEX_DATA_DIR", "")
if data_dir_raw:
    os.environ["CORTEX_DATA_DIR"] = str(Path(data_dir_raw).expanduser())

# Add the cortex python dir to sys.path so imports work
SCRIPT_DIR = Path(__file__).parent.resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# MCP SDK imports
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# UnifiedBrain — single backend for everything
from brain import UnifiedBrain

# Temporal/abstraction modules (still delegated for Phase 1)
import temporal_analysis
import deep_abstraction
import atomizer

# GPU embeddings daemon helpers (best-effort, for stats/dedupe)
import requests

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.environ.get("CORTEX_DATA_DIR", SCRIPT_DIR))
EMBEDDINGS_URL = os.environ.get("EMBEDDINGS_URL", "http://localhost:8030")

# The brain
brain = UnifiedBrain(str(DATA_DIR / "brain.db"))


def _daemon_stats() -> dict:
    """Get stats from the GPU embeddings daemon (best-effort)."""
    try:
        resp = requests.get(f"{EMBEDDINGS_URL}/stats", timeout=3)
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return {"total": 0, "by_category": {}, "model": "unavailable", "daemon_running": False}


def _daemon_store(content: str, categories: list, importance: float) -> dict:
    """Store a memory via the GPU embeddings daemon (best-effort)."""
    try:
        resp = requests.post(
            f"{EMBEDDINGS_URL}/store",
            json={"content": content, "categories": categories, "importance": importance},
            timeout=5,
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return {"stored": False, "error": "embeddings daemon not available"}


def _daemon_search_dedupe(threshold: float = 0.92) -> list:
    """Find near-duplicate memories via semantic similarity."""
    try:
        resp = requests.get(f"{EMBEDDINGS_URL}/dump", timeout=10)
        if resp.status_code != 200:
            return []
        memories = resp.json().get("memories", [])
    except Exception:
        return []

    import numpy as np

    dupes = []
    embeddings = []
    meta = []
    for m in memories:
        emb = m.get("embedding")
        if emb:
            embeddings.append(np.array(emb, dtype=np.float32))
            meta.append(m)

    for i in range(len(embeddings)):
        for j in range(i + 1, len(embeddings)):
            sim = float(np.dot(embeddings[i], embeddings[j]) / (
                np.linalg.norm(embeddings[i]) * np.linalg.norm(embeddings[j])
            ))
            if sim >= threshold:
                dupes.append({
                    "memory_a": meta[i]["content"][:80],
                    "memory_b": meta[j]["content"][:80],
                    "similarity": round(sim, 4),
                    "id_a": meta[i]["id"],
                    "id_b": meta[j]["id"],
                })

    dupes.sort(key=lambda x: x["similarity"], reverse=True)
    return dupes[:20]


def ok(text: str) -> list:
    """Return a success text content list."""
    return [TextContent(type="text", text=text)]


def err(text: str) -> list:
    """Return an error text content list."""
    return [TextContent(type="text", text=f"ERROR: {text}")]


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

server = Server("cortex-memory")


# ========================== TOOL DEFINITIONS ================================

CORTEX_TOOL = Tool(
    name="cortex",
    description=(
        "Cortex shared memory system. Manages short-term memory (STM), "
        "long-term embeddings, working memory pins, and categories. "
        "Actions: add, stm, stats, edit, update, move, dedupe, "
        "create_category, list_categories, wm_pin, wm_view, wm_clear, "
        "unified_search"
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "add", "stm", "stats", "edit", "update", "move", "dedupe",
                    "create_category", "list_categories",
                    "wm_pin", "wm_view", "wm_clear",
                    "unified_search",
                ],
                "description": "Which cortex action to perform",
            },
            "content": {
                "type": "string",
                "description": "Memory content (for add, edit, wm_pin)",
            },
            "categories": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Category list (for add, move, create_category)",
            },
            "importance": {
                "type": "number",
                "description": "Importance score 0-3 (for add, update). Default 1.0",
            },
            "memory_id": {
                "type": "string",
                "description": "Memory ID (for edit, update, move)",
            },
            "count": {
                "type": "integer",
                "description": "Number of items to return (for stm). Default 10",
            },
            "category": {
                "type": "string",
                "description": "Single category filter (for stm) or name (for create_category)",
            },
            "threshold": {
                "type": "number",
                "description": "Similarity threshold for dedupe. Default 0.92",
            },
            "keywords": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Keywords for create_category",
            },
            "label": {
                "type": "string",
                "description": "Label for wm_pin",
            },
            "index": {
                "type": "integer",
                "description": "Index for wm_clear (omit to clear all)",
            },
            "query": {
                "type": "string",
                "description": "Search query (for unified_search)",
            },
            "types": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Content types to search: message, stm, atom (for unified_search). Default: all",
            },
        },
        "required": ["action"],
    },
)

ATOM_TOOL = Tool(
    name="atom",
    description=(
        "Atomic knowledge units — structured causal knowledge with "
        "field-level embeddings and causal chain traversal. "
        "Actions: create, search, find_causes, link, stats, atomize, classify"
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["create", "search", "find_causes", "link", "stats", "atomize", "classify"],
                "description": "Which atom action to perform",
            },
            "subject": {
                "type": "string",
                "description": "Who/what (for create)",
            },
            "action_text": {
                "type": "string",
                "description": "Does what (for create). Named action_text to avoid clash with action param",
            },
            "outcome": {
                "type": "string",
                "description": "Result (for create)",
            },
            "consequences": {
                "type": "string",
                "description": "What follows (for create)",
            },
            "confidence": {
                "type": "number",
                "description": "Confidence 0-1 (for create). Default 1.0",
            },
            "query": {
                "type": "string",
                "description": "Search query (for search, classify, atomize)",
            },
            "field": {
                "type": "string",
                "enum": ["subject", "action", "outcome", "consequences"],
                "description": "Field to search by (for search). Default: outcome",
            },
            "atom_id": {
                "type": "string",
                "description": "Atom ID (for find_causes)",
            },
            "max_depth": {
                "type": "integer",
                "description": "Max traversal depth (for find_causes). Default 10",
            },
            "from_id": {
                "type": "string",
                "description": "Source atom ID (for link)",
            },
            "to_id": {
                "type": "string",
                "description": "Target atom ID (for link)",
            },
            "link_type": {
                "type": "string",
                "enum": ["causes", "enables", "precedes", "correlates"],
                "description": "Causal link type (for link). Default: causes",
            },
            "strength": {
                "type": "number",
                "description": "Link strength 0-1 (for link). Default 0.5",
            },
            "text": {
                "type": "string",
                "description": "Text to atomize (for atomize)",
            },
        },
        "required": ["action"],
    },
)

TEMPORAL_TOOL = Tool(
    name="temporal",
    description=(
        "Time-aware causal analysis — temporal search, precursor detection, "
        "pattern analysis, and deep abstraction. "
        "Actions: search, what_happened_before, patterns, abstract_deeper"
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["search", "what_happened_before", "patterns", "abstract_deeper"],
                "description": "Which temporal action to perform",
            },
            "query": {
                "type": "string",
                "description": "Search query or event description",
            },
            "time_reference": {
                "type": "string",
                "description": "Time reference like '4 hours ago', 'yesterday', 'last week' (for search)",
            },
            "event": {
                "type": "string",
                "description": "Event description (for what_happened_before)",
            },
            "hours_before": {
                "type": "integer",
                "description": "Hours to look back (for what_happened_before). Default 4",
            },
            "days_before": {
                "type": "integer",
                "description": "Days to look back (for what_happened_before). Converted to hours",
            },
            "outcome": {
                "type": "string",
                "description": "Outcome pattern to analyze (for patterns)",
            },
            "min_observations": {
                "type": "integer",
                "description": "Min observations required (for patterns). Default 3",
            },
        },
        "required": ["action"],
    },
)


SYNAPSE_TOOL = Tool(
    name="synapse",
    description=(
        "SYNAPSE — inter-agent messaging between Helios and Claude Code. "
        "Structured messages with addressing, read/unread tracking, priority, "
        "and threading. Actions: send, inbox, read, ack, history, list_threads"
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["send", "inbox", "read", "ack", "history", "list_threads"],
                "description": "Which synapse action to perform",
            },
            "from_agent": {
                "type": "string",
                "description": "Sender agent ID (for send). Defaults to 'claude-code'",
            },
            "to_agent": {
                "type": "string",
                "description": "Recipient agent ID (for send). e.g. 'helios', 'claude-code', 'all'",
            },
            "subject": {
                "type": "string",
                "description": "Message subject (for send)",
            },
            "body": {
                "type": "string",
                "description": "Message body (for send, ack)",
            },
            "priority": {
                "type": "string",
                "enum": ["info", "action", "urgent"],
                "description": "Message priority (for send). Default: info",
            },
            "thread_id": {
                "type": "string",
                "description": "Thread ID to continue a conversation (for send, history)",
            },
            "message_id": {
                "type": "string",
                "description": "Message ID (for read, ack)",
            },
            "agent_id": {
                "type": "string",
                "description": "Agent ID for filtering (for inbox, history). Defaults to 'claude-code'",
            },
            "include_read": {
                "type": "boolean",
                "description": "Include already-read messages in inbox. Default: false",
            },
            "limit": {
                "type": "integer",
                "description": "Max messages to return (for history, list_threads). Default: 20",
            },
        },
        "required": ["action"],
    },
)


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [CORTEX_TOOL, ATOM_TOOL, TEMPORAL_TOOL, SYNAPSE_TOOL]


# ========================== TOOL HANDLERS ==================================

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "cortex":
        return await _handle_cortex(arguments)
    elif name == "atom":
        return await _handle_atom(arguments)
    elif name == "temporal":
        return await _handle_temporal(arguments)
    elif name == "synapse":
        return await _handle_synapse(arguments)
    else:
        return err(f"Unknown tool: {name}")


# ---------------------------------------------------------------------------
# CORTEX handler (13 actions — original 12 + unified_search)
# ---------------------------------------------------------------------------

async def _handle_cortex(args: dict) -> list[TextContent]:
    action = args.get("action", "")

    if action == "add":
        content = args.get("content")
        if not content:
            return err("content is required for add")
        categories = args.get("categories", ["general"])
        importance = args.get("importance", 1.0)

        # Store in brain.db STM
        mem_id = brain.remember(content, categories=categories, importance=importance, source="mcp")

        # Also store in GPU daemon (best-effort, for real-time embedding)
        daemon_result = _daemon_store(content, categories, importance)

        return ok(json.dumps({
            "stored": True,
            "memory_id": mem_id,
            "categories": categories,
            "importance": importance,
            "daemon_stored": daemon_result.get("stored", False),
            "backend": "brain.db",
        }, indent=2))

    elif action == "stm":
        count = args.get("count", 10)
        category = args.get("category")
        items = brain.get_stm(limit=count, category=category)
        return ok(json.dumps({
            "count": len(items),
            "items": items,
        }, indent=2))

    elif action == "stats":
        daemon = _daemon_stats()
        brain_stats = brain.stats()
        atom_stats = brain.atom_stats()
        wm = brain.wm_view()

        return ok(json.dumps({
            "stm_count": brain_stats.get("stm_entries", 0),
            "embeddings_total": brain_stats.get("embeddings", 0),
            "embeddings_by_type": brain_stats.get("embeddings_by_type", {}),
            "messages_total": brain_stats.get("messages", 0),
            "threads_total": brain_stats.get("threads", 0),
            "daemon_total": daemon.get("total", 0),
            "daemon_model": daemon.get("model", "unknown"),
            "daemon_running": daemon.get("daemon_running", daemon.get("total", 0) > 0 or daemon.get("model") != "unavailable"),
            "atoms_total": atom_stats.get("total_atoms", 0),
            "causal_links": atom_stats.get("total_causal_links", 0),
            "working_memory_pins": wm.get("count", 0),
            "backend": "brain.db",
        }, indent=2))

    elif action == "edit":
        memory_id = args.get("memory_id")
        content = args.get("content")
        if not memory_id or not content:
            return err("memory_id and content are required for edit")

        updated = brain.edit_stm(memory_id, content)
        return ok(json.dumps({"updated": updated, "memory_id": memory_id}))

    elif action == "update":
        memory_id = args.get("memory_id")
        if not memory_id:
            return err("memory_id is required for update")

        importance = args.get("importance")
        categories = args.get("categories")

        if importance is None and categories is None:
            return err("No fields to update. Provide importance or categories.")

        updated = brain.update_stm(memory_id, importance=importance, categories=categories)
        return ok(json.dumps({"updated": updated, "memory_id": memory_id}))

    elif action == "move":
        memory_id = args.get("memory_id")
        categories = args.get("categories")
        if not memory_id or not categories:
            return err("memory_id and categories are required for move")

        updated = brain.update_stm(memory_id, categories=categories)
        return ok(json.dumps({"moved": updated, "memory_id": memory_id, "new_categories": categories}))

    elif action == "dedupe":
        threshold = args.get("threshold", 0.92)
        dupes = _daemon_search_dedupe(threshold)
        return ok(json.dumps({
            "duplicates_found": len(dupes),
            "threshold": threshold,
            "duplicates": dupes,
        }, indent=2))

    elif action == "create_category":
        name = args.get("category")
        description = args.get("description", "")
        keywords = args.get("keywords", [])
        if not name:
            return err("category (name) is required for create_category")

        result = brain.create_category(name, description=description, keywords=keywords)
        return ok(json.dumps(result))

    elif action == "list_categories":
        result = brain.list_categories()
        return ok(json.dumps(result, indent=2))

    elif action == "wm_pin":
        content = args.get("content")
        if not content:
            return err("content is required for wm_pin")
        label = args.get("label", "")

        result = brain.wm_pin(content, label)
        return ok(json.dumps(result))

    elif action == "wm_view":
        result = brain.wm_view()
        return ok(json.dumps(result, indent=2))

    elif action == "wm_clear":
        index = args.get("index")
        result = brain.wm_clear(index)
        return ok(json.dumps(result))

    elif action == "unified_search":
        query = args.get("query") or args.get("content")
        if not query:
            return err("query is required for unified_search")

        types = args.get("types")
        limit = args.get("count", 20)
        results = brain.unified_search(query, limit=limit, types=types)

        return ok(json.dumps({
            "query": query,
            "count": len(results),
            "results": results,
        }, indent=2))

    else:
        return err(f"Unknown cortex action: {action}")


# ---------------------------------------------------------------------------
# ATOM handler (7 actions)
# ---------------------------------------------------------------------------

async def _handle_atom(args: dict) -> list[TextContent]:
    action = args.get("action", "")

    if action == "create":
        subject = args.get("subject")
        action_text = args.get("action_text")
        outcome = args.get("outcome")
        consequences = args.get("consequences")

        if not all([subject, action_text, outcome, consequences]):
            return err("subject, action_text, outcome, and consequences are all required for create")

        confidence = args.get("confidence", 1.0)

        atom_id = brain.create_atom(
            subject=subject,
            action=action_text,
            outcome=outcome,
            consequences=consequences,
            source="mcp",
            confidence=confidence,
        )

        return ok(json.dumps({
            "created": True,
            "atom_id": atom_id,
            "subject": subject,
            "action": action_text,
            "outcome": outcome,
            "consequences": consequences,
            "confidence": confidence,
        }, indent=2))

    elif action == "search":
        query = args.get("query")
        if not query:
            return err("query is required for search")

        field = args.get("field", "outcome")
        results = brain.search_atoms(field, query, limit=10)

        return ok(json.dumps({
            "query": query,
            "field": field,
            "count": len(results),
            "results": results,
        }, indent=2))

    elif action == "find_causes":
        atom_id = args.get("atom_id")
        if not atom_id:
            return err("atom_id is required for find_causes")

        max_depth = args.get("max_depth", 10)
        roots = brain.find_root_causes(atom_id, max_depth=max_depth)

        return ok(json.dumps({
            "atom_id": atom_id,
            "max_depth": max_depth,
            "root_causes_found": len(roots),
            "root_causes": roots,
        }, indent=2))

    elif action == "link":
        from_id = args.get("from_id")
        to_id = args.get("to_id")
        if not from_id or not to_id:
            return err("from_id and to_id are required for link")

        link_type = args.get("link_type", "causes")
        strength = args.get("strength", 0.5)

        brain.link_atoms(from_id, to_id, link_type, strength)

        return ok(json.dumps({
            "linked": True,
            "from_id": from_id,
            "to_id": to_id,
            "link_type": link_type,
            "strength": strength,
        }, indent=2))

    elif action == "stats":
        s = brain.atom_stats()
        return ok(json.dumps(s, indent=2))

    elif action == "atomize":
        text = args.get("text") or args.get("query")
        if not text:
            return err("text is required for atomize")

        # Still uses the atomizer module (it creates atoms in .atoms.db)
        # TODO: Phase 2 — atomizer should use brain.create_atom
        atom_ids = atomizer.atomize_text(text, source="mcp", save_to_db=True)

        return ok(json.dumps({
            "text": text[:100] + ("..." if len(text) > 100 else ""),
            "atoms_created": len(atom_ids),
            "atom_ids": atom_ids,
        }, indent=2))

    elif action == "classify":
        query = args.get("query")
        if not query:
            return err("query is required for classify")

        query_type, confidence = deep_abstraction.classify_query(query)

        return ok(json.dumps({
            "query": query,
            "query_type": query_type,
            "confidence": confidence,
        }, indent=2))

    else:
        return err(f"Unknown atom action: {action}")


# ---------------------------------------------------------------------------
# TEMPORAL handler (4 actions — delegates to existing modules)
# ---------------------------------------------------------------------------

async def _handle_temporal(args: dict) -> list[TextContent]:
    action = args.get("action", "")

    if action == "search":
        query = args.get("query")
        time_reference = args.get("time_reference")
        if not query or not time_reference:
            return err("query and time_reference are required for search")

        result = brain.temporal_search(query, time_reference)
        return ok(json.dumps(result, indent=2, default=str))

    elif action == "what_happened_before":
        event = args.get("event") or args.get("query")
        if not event:
            return err("event (or query) is required for what_happened_before")

        hours = args.get("hours_before", 4)
        if args.get("days_before"):
            hours = args["days_before"] * 24

        result = brain.what_happened_before(event, hours_before=hours)
        return ok(json.dumps(result, indent=2, default=str))

    elif action == "patterns":
        outcome = args.get("outcome") or args.get("query")
        if not outcome:
            return err("outcome (or query) is required for patterns")

        min_obs = args.get("min_observations", 3)
        result = brain.temporal_patterns(outcome, min_observations=min_obs)
        return ok(json.dumps(result, indent=2, default=str))

    elif action == "abstract_deeper":
        query = args.get("query")
        if not query:
            return err("query is required for abstract_deeper")

        result = brain.abstract_deeper(query)
        return ok(json.dumps(result, indent=2, default=str))

    else:
        return err(f"Unknown temporal action: {action}")


# ---------------------------------------------------------------------------
# SYNAPSE handler (6 actions — original 5 + list_threads)
# ---------------------------------------------------------------------------

async def _handle_synapse(args: dict) -> list[TextContent]:
    action = args.get("action", "")

    if action == "send":
        from_agent = args.get("from_agent", "claude-code")
        to_agent = args.get("to_agent")
        subject = args.get("subject")
        body = args.get("body")
        if not to_agent or not subject or not body:
            return err("to_agent, subject, and body are required for send")

        priority = args.get("priority", "info")
        thread_id = args.get("thread_id")

        msg = brain.send(
            from_agent=from_agent,
            to_agent=to_agent,
            subject=subject,
            body=body,
            priority=priority,
            thread_id=thread_id,
        )

        return ok(json.dumps({
            "sent": True,
            "id": msg["id"],
            "thread_id": msg["thread_id"],
            "from": msg["from"],
            "to": msg["to"],
            "priority": msg["priority"],
            "subject": msg["subject"],
        }, indent=2))

    elif action == "inbox":
        agent_id = args.get("agent_id", "claude-code")
        include_read = args.get("include_read", False)

        messages = brain.inbox(agent_id, include_read=include_read)

        return ok(json.dumps({
            "agent_id": agent_id,
            "count": len(messages),
            "messages": messages,
        }, indent=2, default=str))

    elif action == "read":
        message_id = args.get("message_id")
        if not message_id:
            return err("message_id is required for read")

        agent_id = args.get("agent_id", "claude-code")
        msg = brain.read_message(message_id, agent_id)

        if not msg:
            return err(f"Message not found: {message_id}")

        return ok(json.dumps(msg, indent=2, default=str))

    elif action == "ack":
        message_id = args.get("message_id")
        if not message_id:
            return err("message_id is required for ack")

        agent_id = args.get("agent_id", "claude-code")
        ack_body = args.get("body")
        msg = brain.ack(message_id, agent_id, ack_body=ack_body)

        if not msg:
            return err(f"Message not found: {message_id}")

        return ok(json.dumps({
            "acknowledged": True,
            "id": msg["id"],
            "status": msg["status"],
            "ack_body": msg.get("ack_body"),
        }, indent=2))

    elif action == "history":
        agent_id = args.get("agent_id")
        thread_id = args.get("thread_id")
        limit = args.get("limit", 20)

        messages = brain.history(
            agent_id=agent_id,
            thread_id=thread_id,
            limit=limit,
        )

        return ok(json.dumps({
            "count": len(messages),
            "messages": messages,
        }, indent=2, default=str))

    elif action == "list_threads":
        limit = args.get("limit", 50)
        threads = brain.list_threads(limit=limit)

        return ok(json.dumps({
            "count": len(threads),
            "threads": threads,
        }, indent=2, default=str))

    else:
        return err(f"Unknown synapse action: {action}")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
