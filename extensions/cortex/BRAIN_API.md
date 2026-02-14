# Brain API — REST Interface for brain.db

**Port:** 8031  
**Status:** Running as systemd service `brain-api.service`  
**Database:** `~/.openclaw/workspace/memory/brain.db` (SQLite, WAL mode)

## Endpoints

### Health Check
```
GET /health
→ { "status": "ok", "db_path": "...", "messages": N, "stm_entries": N, "atoms": N, "embeddings": N }
```

### Remember (Store Memory)
```
POST /remember
Content-Type: application/json

{
  "content": "Memory content text",
  "categories": ["coding", "meta"],
  "importance": 2.0,
  "source": "agent"
}

→ { "id": "stm_abc123" }
```

### Get STM (Short-Term Memory)
```
GET /stm?limit=100&category=coding

→ {
    "entries": [
      {
        "id": "stm_abc123",
        "content": "...",
        "categories": ["coding"],
        "importance": 2.0,
        "access_count": 5,
        "created_at": "2026-02-14T12:00:00",
        "updated_at": null,
        "expires_at": null,
        "source": "agent",
        "source_message_id": null
      }
    ]
  }
```

### Search (Semantic)
```
GET /search?q=memory%20system&limit=10

→ { "results": [...] }
```

### Stats
```
GET /stats

→ { "stm_count": N, "atom_count": N, "message_count": N, "embedding_count": N }
```

### Embed (Store Embedding)
```
POST /embed
Content-Type: application/json

{
  "content": "Text to embed",
  "categories": ["meta"],
  "importance": 1.5
}
```

### Atom (Causal Knowledge)
```
POST /atom
Content-Type: application/json

{
  "subject": "whale wallet",
  "action": "accumulates token X",
  "outcome": "concentration visible",
  "consequences": "precedes price movement",
  "confidence": 0.9
}
```

### Synapse Messages
```
POST /send — Send inter-agent message
GET /inbox/{agent} — Get messages for agent
```

## Integration Points

- **Cortex extension** (index.ts) — Primary consumer via Python bridge
- **conversation-summarizer** — Stores summaries via POST /remember
- **self-reflection** — Reads STM via GET /stm, stores via POST /remember
- **consolidation engine** — Direct SQLite access for batch operations
- **OpenClaw cron jobs** — Indirect via cortex tools

## Database Schema

```sql
-- Core STM table
CREATE TABLE stm (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  categories TEXT,      -- JSON array
  importance REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  expires_at TEXT,
  source TEXT,
  source_message_id TEXT
);

-- Full-text search index
CREATE VIRTUAL TABLE stm_fts USING fts5(content, content=stm, content_rowid=rowid);

-- Atoms (causal knowledge)
CREATE TABLE atoms (...);

-- Messages (synapse)
CREATE TABLE messages (...);

-- Working memory (pinned)
CREATE TABLE working_memory (...);

-- Categories
CREATE TABLE categories (...);
```

## Maintenance

- **Daily hygiene:** `scripts/memory-hygiene.sh` (cron at 4 AM)
- **Consolidation:** `scripts/memory-consolidation/consolidate.py prune`
- **Backup:** Included in nightly `backup_to_drive.sh`
- **WAL mode:** Enables concurrent reads/writes

---
*Last updated: 2026-02-14 (v0.3.0 sprint)*
