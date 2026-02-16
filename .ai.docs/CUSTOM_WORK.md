# Helios Custom Work Documentation

## Overview
This document catalogs all 62 custom commits made to the Helios fork (branch: main) that are ahead of upstream origin/main.

## Commit Categories

### **FEATURES (22 commits)**

#### **Core Extensions System**
- `15ae016d6` - feat(extensions): add Cortex memory extension
- `266b0c001` - feat(extensions): add conversation-summarizer and self-reflection agents  
- `4c4286cd2` - cortex: implement top 5 memory management features from Helios spec
- `dd9665fe0` - cortex: move Python backend into repo, add CORTEX_DATA_DIR support
- `cb358d382` - cortex: implement Phase 3 Atomic Knowledge system
- `338be6bb1` - feat(cortex): Phase 2 Memory Expansion - Hot Tier + Token Budget
- `e0ced42db` - feat(cortex): Phase 1 Memory Expansion - RAM caching for microsecond retrieval

#### **Brain Database System**
- `694000c32` - feat: brain.db Phase 4 — REST API, WM/categories, 75 tests
- `c9d10e7b2` - feat: working_memory bidirectional sync (JSON ↔ brain.db)
- `316799c56` - feat: brain.db backup/export utility — Nova
- `bc601346f` - feat: provenance chain HTML visualizer — Nova
- `3ca76412a` - feat(brain): todo system with templates

#### **SYNAPSE V2 Communication**
- `5696b2491` - SYNAPSE V2: task delegation protocol + 18 new tests

#### **Memory & Monitoring**
- `3042dd562` - Self-Monitoring Dashboard + 8 tests
- `45060efa8` - Memory Consolidation Engine + 10 tests

#### **LBF Enterprise Integration**
- `ff6790095` - feat: update default model to Claude Opus 4.6, fix models-config test failures
- `f743e9477` - feat: add native LBF Enterprise task board tool

#### **Model & Auth Support**
- `44fcdce11` - feat: support Anthropic OAuth profiles in model resolution
- `6f27756c3` - Fix: Add data: URI (RFC 2397) support for audio attachments

#### **Workspace Bootstrap**
- `e439be33e` - H0-4: workspace bootstrap file content-hash caching

### **FIXES (25 commits)**

#### **Brain DB Migration Fixes**
- `ac8895e0c` - fix(cortex-bridge): loadSTMDirect now reads from brain.db instead of empty stm.json
- `ccff761e8` - fix(extensions): migrate conversation-summarizer and self-reflection from stm.json to brain.db
- `78f7ad76a` - fix(cortex): migrate cortex_update, cortex_edit, cortex_move from stm.json to brain.db
- `f22cf50fa` - fix(cortex): dedup merge/delete now uses brain.db instead of stale stm.json
- `d22974896` - fix(self-reflection): correct brain_api response shape (entries array)

#### **Brain DB Core Fixes**
- `45506cd67` - fix: brain.py conn.close ordering + remove dead _extract_causal_patterns (Nova QA)
- `27caefc7c` - fix: create_category kwarg bug in mcp_server.py (Nova QA report)
- `b6cae3ee3` - fix: add PRAGMA busy_timeout=5000 to brain.py for WAL lock contention
- `098c34ab8` - fix: all managers use correct brain.db path
- `6c749b024` - brain.py: fix DB path, remove FK, add provenance chain

#### **Cortex System Fixes**
- `cb56d2d53` - fix(cortex): add categories param to embeddings_manager, dedupe auto-capture
- `9280bdf9d` - fix(extensions): fix cortex config null check and remove memory slot conflict
- `343a1745e` - fix(cortex): lower minimum maxContextTokens to 100 for tighter budgets
- `06854e481` - fix(cortex): lower default token budget to 500 to prevent context overflow

#### **Core Tool Fixes**
- `8bd10ccca` - fix: support alternate tool call ID fields and guard toLowerCase
- `d24e6cfab` - fix: support snake_case 'tool_use' in Anthropic transcript repair
- `e5300387c` - test: add coverage for Anthropic snake_case tool_use format
- `7ed85543a` - fix: resolve multiple tool issues (#8169, #8154, #8096, #8157)

#### **Test Infrastructure Fixes**
- `4c4286cd2` - fix(tests): use dynamic config path to respect test isolation
- `5525d8146` - fix(agents): show cooldown remaining time in fallback errors
- `e0ced42db` - fix(extensions): lint fixes for conversation-summarizer and self-reflection

#### **Miscellaneous Fixes**
- `4ae70200e` - fix: address PR review feedback

### **CHORES (7 commits)**

#### **Version Management**
- `e7f5d9295` - chore: version bump to 2026.2.15 - post-audit release
- `340755472` - chore: upgrade .ai.index to v1.3.0 (CI-verifiable refs)

#### **Code Quality**
- `2be31373e` - chore(cortex): add pre-commit hook warning for stm.json writes
- `9bd75302e` - chore: add Claude Code MCP config, remove empty dirs
- `7a8e40d97` - chore(skills): make transcribe.sh executable
- `4251e122a` - Merge branch 'phase2-memory-expansion'

#### **Deprecated**
- `81db9db86` - opus (likely typo/incomplete commit)

### **DOCS (5 commits)**
- `4bdc1dba0` - docs: codebase audit - 101 refactoring opportunities identified
- `1e15c045e` - docs: add AI documentation (register, toc, index) for helios
- `7514306f7` - docs(cortex): add Brain API REST interface documentation
- `cb56d2d53` - docs: add Cortex Memory System to README
- `a02523184` - docs: add ACP MCP implementation guide (Option A)

### **TESTS (3 commits)**
- `d22974896` - test: add comprehensive tests for delete_stm() and delete_stm_batch() methods
- `bc601346f` - test: MCP integration smoke tests (6/6 pass) — Nova
- `643e05400` - test: concurrent write stress test (6/6 passing)

## Critical Custom Systems

### 1. Cortex Memory System
**Location**: `extensions/cortex/`
**Purpose**: Advanced memory management with hot-tier caching, token budgeting, and semantic search
**Key Files**:
- `extensions/cortex/python/brain.py` - Core database operations
- `extensions/cortex/python/brain_api.py` - REST API interface  
- `extensions/cortex/python/embeddings_manager.py` - Semantic embeddings
- `extensions/cortex/python/stm_manager.py` - Short-term memory
- `extensions/cortex/cortex-bridge.ts` - TypeScript bridge

### 2. Brain Database (brain.db)
**Location**: `extensions/cortex/python/`
**Purpose**: SQLite-based persistent memory replacing JSON files
**Migration**: All cortex operations migrated from stm.json to brain.db
**Features**: Provenance chains, atomic knowledge, concurrent write safety

### 3. SYNAPSE V2 Protocol
**Location**: Various components
**Purpose**: Inter-agent communication and task delegation
**Integration**: Embedded in brain.py for automatic atom extraction

### 4. LBF Enterprise Integration
**Location**: `src/agents/tools/lbf-tool.ts`
**Purpose**: Native task board integration for enterprise workflows
**Features**: ITSM status, SLA monitoring, pipeline management

### 5. Anthropic OAuth Profiles
**Location**: `apps/macos/Sources/OpenClaw/AnthropicOAuth.swift`
**Purpose**: Multiple authentication profile support
**Integration**: Model resolution system

### 6. Atomic Knowledge System
**Location**: `extensions/cortex/python/atom_manager.py`
**Purpose**: Causal reasoning and knowledge atomization
**Features**: Temporal analysis, deep abstraction chains

## File Modification Summary

### Most Modified Areas:
1. **extensions/cortex/** - Entire new system (100+ files)
2. **src/agents/** - Tool integrations and model handling
3. **apps/macos/** - OAuth and UI integration  
4. **extensions/conversation-summarizer/** - New extension
5. **extensions/self-reflection/** - New extension

### Core Infrastructure Changes:
- **package.json** - Version and dependency updates
- **openclaw.mjs** - Main entry point modifications
- **tsconfig.json** - TypeScript configuration changes
- **.ai.docs/** - Complete AI documentation system

## Recovery Instructions

If any custom work is lost during merge:

1. **Checkout safety tag**: `git checkout pre-upstream-sync-2026.2.16`
2. **Extract specific system**: `git show <commit-hash> -- <path>` 
3. **Full recovery**: `git cherry-pick <commit-range>`
4. **Backup branch available**: `backup/pre-upstream-sync`

## Dependencies

### Python Dependencies (Brain System):
- SQLite3 with WAL mode
- sentence-transformers for embeddings  
- FastAPI for REST API
- asyncio for concurrent operations

### Node.js Dependencies:
- TypeScript for cortex bridge
- Updated model providers
- Enhanced tool policy system

## Testing Coverage

- **Brain DB**: 75+ tests for concurrent operations
- **Cortex**: Integration tests for memory operations
- **SYNAPSE**: 18 tests for protocol compliance
- **Extensions**: Smoke tests for all new components

## Version Evolution

- **Pre-merge**: Custom semver system established
- **Current**: 2026.2.15 (upstream date format)
- **Target**: v1.12.40 (semver with upstream features/fixes)