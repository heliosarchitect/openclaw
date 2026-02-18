# Cortex Memory Extension

OpenClaw memory extension providing long-term knowledge storage, semantic search, and confidence-based reliability scoring.

> **🤖 AI Agents:** Read [`cortex.ai.toc`](cortex.ai.toc) first — it's a 500-token project map. Use [`BRAIN_API.md`](BRAIN_API.md) for API reference and [`ARCHITECTURE.md`](ARCHITECTURE.md) for technical details. See [`sop/INDEX.md`](sop/INDEX.md) for operational procedures.

## Overview

Cortex extends OpenClaw with persistent memory, semantic search, and knowledge management. It stores conversations, insights, and structured knowledge in a unified brain.db database with confidence scoring to ensure reliability. Used by all LBF agents for cross-session context retention and knowledge sharing.

## Architecture

```
┌─ OpenClaw Agent ─────┐    ┌─ Cortex Extension ─────────┐    ┌─ Brain Database ─┐
│  • Memory tools      │ ─► │ • cortex-bridge.ts         │ ─► │ • brain.db       │
│  • Search queries    │    │ • ConfidenceEngine         │    │ • STM entries    │
│  • Knowledge storage │    │ • UnifiedBrain API         │    │ • Embeddings     │
│                      │    │ • Temporal search          │    │ • Atoms & links  │
└──────────────────────┘    └────────────────────────────┘    └──────────────────┘
```

Core components:

- **cortex-bridge.ts**: TypeScript interface to Python brain
- **brain.py**: Unified database operations and search
- **confidence_engine.py**: Memory reliability scoring
- **MCP server**: External tool access via Model Context Protocol

## Quick Start

```bash
# Install dependencies
cd ~/Projects/helios/extensions/cortex/python
pip install -r requirements.txt

# Initialize database (if needed)
python3 brain.py --init

# Check system status
python3 -m openclaw-cli cortex_stats

# Add a memory
python3 -m openclaw-cli cortex_add --content "Important insight" --importance 2.0

# Search memories
python3 -m openclaw-cli unified_search --query "insight" --limit 5
```

## Configuration

| Setting               | Location                    | Description                              |
| --------------------- | --------------------------- | ---------------------------------------- |
| `stmCapacity`         | `~/.openclaw/openclaw.json` | Maximum STM entries (default: 2000)      |
| `confidenceThreshold` | `cortex-bridge.ts`          | Minimum confidence for filtering         |
| `embeddingModel`      | `python/brain.py`           | Semantic search model (all-MiniLM-L6-v2) |
| `CORTEX_DATA_DIR`     | Environment                 | Brain database location                  |

## Services

| Service    | Command                 | Port  | Status    |
| ---------- | ----------------------- | ----- | --------- |
| Brain API  | `python3 brain_api.py`  | 8031  | Active    |
| MCP Server | `python3 mcp_server.py` | stdio | On-demand |

## Databases

| Database       | Path                         | Purpose                       |
| -------------- | ---------------------------- | ----------------------------- |
| brain.db       | `~/.openclaw/brain.db`       | Unified knowledge storage     |
| .embeddings.db | `~/.openclaw/.embeddings.db` | Legacy (migrated to brain.db) |
| stm.json       | `~/.openclaw/stm.json`       | Legacy (migrated to brain.db) |

## Tools Available

| Tool             | Purpose              | Confidence Integration          |
| ---------------- | -------------------- | ------------------------------- |
| `cortex_add`     | Store new memories   | Sets initial confidence 1.0     |
| `cortex_stm`     | View recent context  | Shows confidence %              |
| `cortex_stats`   | System statistics    | Reports confidence distribution |
| `memory_search`  | Find memories        | Filters by confidence threshold |
| `unified_search` | Cross-type search    | Includes confidence scores      |
| `atom_create`    | Structured knowledge | Causal confidence tracking      |

## Confidence Scoring System

Memories are automatically scored for reliability:

- **Initial**: 1.0 (perfect confidence)
- **Age decay**: -1% per day (gradual reliability decrease)
- **Access boost**: +5% per access (up to 50% bonus)
- **Validation bonus**: +20% per successful execution
- **Contradiction penalty**: -30% per conflicting memory

**Thresholds:**

- Critical operations: 0.8+ required
- Routine operations: 0.5+ required
- Experimental: 0.2+ accepted

## Metrics System (v1.3.0+)

Cortex includes a tamper-evident metrics collection system that tracks memory operations, SOP enforcement, and system performance without agent bias.

**Key Features:**

- **Tamper-evident design**: Code writes metrics, not agents
- **SQLite database**: ~/.openclaw/metrics.db with WAL mode
- **Automatic logging**: SOP events, memory injections, synapse communication
- **QA reporting**: Raw SQL queries for independent verification

**Database Tables:**

- `cortex_metrics`: Memory injection, confidence scoring events
- `synapse_metrics`: Inter-agent communication and latency
- `pipeline_metrics`: Development pipeline performance
- `sop_events`: Standard operating procedure enforcement

**Usage:**

```bash
# Check metrics collection status
sqlite3 ~/.openclaw/metrics.db "SELECT COUNT(*) FROM cortex_metrics WHERE date(timestamp) = date('now')"

# Generate QA report
python3 scripts/generate-qa-report.py --template sop/qa-report-template.md

# Daily maintenance
sqlite3 ~/.openclaw/metrics.db "PRAGMA optimize; VACUUM;"
```

See [docs/metrics-architecture.md](docs/metrics-architecture.md) for technical details and [sop/metrics.ai.sop](sop/metrics.ai.sop) for operational procedures.

## ⛔ Constraints (What NOT To Do)

- **NO direct brain.db writes** — Use UnifiedBrain class only. Direct SQLite writes corrupt FTS5 indexes and break semantic search.
- **NO confidence scores outside 0.1-1.0** — Breaks filtering logic and causes tool failures. Use ConfidenceEngine.clamp() method.
- **NO synchronous confidence updates** — Blocks memory operations. Use async/batch updates only.
- **NO STM capacity >10,000** — Causes gateway hangs during initialization. Production limit: 2,000 entries.

## Migration from Legacy Systems

If upgrading from pre-v1.2.0:

```bash
# Run confidence migration (one-time)
cd ~/Projects/helios/extensions/cortex/python
python3 migrate_confidence.py --batch-size 1000

# Verify migration
python3 brain.py --stats
```

## Related Repos

| Repo                                                   | Purpose                 |
| ------------------------------------------------------ | ----------------------- |
| [helios](http://git.fleet.wood:3001/helios/helios)     | Main AI agent framework |
| [openclaw](http://git.fleet.wood:3001/helios/openclaw) | Agent runtime and tools |

---

_Part of the LBF Operations ecosystem. Managed by Helios._  
_Template: lbf-templates/project/README.md_
