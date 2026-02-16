# Helios Custom Work Recovery Guide

## Overview
This document provides comprehensive instructions for recovering custom work from the pre-merge safety tag if anything goes wrong during the upstream sync process.

## Safety Assets Available

### Tags and Branches Created Before Merge
- **Safety Tag**: `pre-upstream-sync-2026.2.16` 
- **Backup Branch**: `backup/pre-upstream-sync`
- **Current State**: All 62 custom commits preserved
- **Pushed To**: `gitea` remote for redundancy

## Complete Recovery Scenarios

### Scenario 1: Total Recovery (Nuclear Option)
If merge completely fails and we need to start over:

```bash
# Navigate to repository
cd ~/Projects/helios

# Reset to pre-merge state
git reset --hard pre-upstream-sync-2026.2.16

# Verify we have all 62 commits
git log --oneline origin/main..HEAD | wc -l  # Should output: 62

# Start merge process over
git merge origin/main
```

### Scenario 2: Partial Recovery (Cherry-Pick Specific Systems)
If only certain systems are lost/broken:

#### Recover Cortex Memory System
```bash
# Get commits related to cortex
git log --oneline pre-upstream-sync-2026.2.16 --grep="cortex" --grep="brain" --grep="memory"

# Cherry-pick specific commits (replace HASH with actual commit hashes)
git cherry-pick 15ae016d6  # feat(extensions): add Cortex memory extension
git cherry-pick 4c4286cd2  # cortex: implement top 5 memory management features
git cherry-pick cb358d382  # cortex: implement Phase 3 Atomic Knowledge system
git cherry-pick 338be6bb1  # feat(cortex): Phase 2 Memory Expansion
git cherry-pick e0ced42db  # feat(cortex): Phase 1 Memory Expansion
git cherry-pick 694000c32  # feat: brain.db Phase 4
```

#### Recover SYNAPSE V2
```bash
git cherry-pick 5696b2491  # SYNAPSE V2: task delegation protocol
```

#### Recover LBF Enterprise Tools
```bash
git cherry-pick ff6790095  # feat: update default model to Claude Opus 4.6
git cherry-pick f743e9477  # feat: add native LBF Enterprise task board tool
```

### Scenario 3: File-Level Recovery
If specific files are corrupted/lost:

#### Recover Complete Extension
```bash
# Recover entire cortex extension
git checkout pre-upstream-sync-2026.2.16 -- extensions/cortex/

# Recover conversation summarizer
git checkout pre-upstream-sync-2026.2.16 -- extensions/conversation-summarizer/

# Recover self-reflection extension
git checkout pre-upstream-sync-2026.2.16 -- extensions/self-reflection/
```

#### Recover Specific Files
```bash
# Recover brain.py
git checkout pre-upstream-sync-2026.2.16 -- extensions/cortex/python/brain.py

# Recover LBF tool
git checkout pre-upstream-sync-2026.2.16 -- src/agents/tools/lbf-tool.ts

# Recover Anthropic OAuth
git checkout pre-upstream-sync-2026.2.16 -- apps/macos/Sources/OpenClaw/AnthropicOAuth.swift
```

## System-Specific Recovery

### Cortex Memory System Recovery

**Files to Verify/Recover:**
```bash
# Core Python backend
extensions/cortex/python/brain.py
extensions/cortex/python/brain_api.py  
extensions/cortex/python/embeddings_manager.py
extensions/cortex/python/stm_manager.py
extensions/cortex/python/atom_manager.py
extensions/cortex/python/deep_abstraction.py
extensions/cortex/python/temporal_analysis.py

# TypeScript bridge
extensions/cortex/cortex-bridge.ts
extensions/cortex/index.ts
extensions/cortex/package.json
extensions/cortex/openclaw.plugin.json

# Tests
extensions/cortex/python/test_brain.py
extensions/cortex/python/test_brain_api.py
extensions/cortex/python/test_brain_concurrent.py
```

**Recovery Command:**
```bash
git checkout pre-upstream-sync-2026.2.16 -- extensions/cortex/
```

### Brain Database Migration Recovery

**Issue**: If cortex tools revert to stm.json instead of brain.db
**Files to Check:**
- All MCP operations should use brain.db
- loadSTMDirect should read from brain.db
- cortex_update/edit/move should use brain.db

**Recovery Commands:**
```bash
# Recover specific brain migration commits
git cherry-pick ac8895e0c  # fix(cortex-bridge): loadSTMDirect brain.db fix
git cherry-pick ccff761e8  # fix(extensions): migrate conversation-summarizer
git cherry-pick 78f7ad76a  # fix(cortex): migrate cortex_update, cortex_edit, cortex_move
git cherry-pick f22cf50fa  # fix(cortex): dedup merge/delete brain.db fix
```

### SYNAPSE V2 Recovery

**Files to Verify:**
```bash
# Check for SYNAPSE integration
grep -r "SYNAPSE" extensions/cortex/python/brain.py
# Should show automatic atom extraction functionality
```

**Recovery:**
```bash
git cherry-pick 5696b2491
# Verify synapse_manager.py exists
ls -la extensions/cortex/python/synapse_manager.py
```

## Validation After Recovery

### Cortex System Validation
```bash
cd extensions/cortex/python

# Test brain.db operations
python3 test_brain.py

# Test API
python3 test_brain_api.py

# Test concurrent operations  
python3 test_brain_concurrent.py

# Verify MCP integration
python3 test_mcp_integration.py
```

### LBF Tools Validation
```bash
# Check LBF tool exists and is functional
grep -n "lbf" src/agents/tools/lbf-tool.ts
# Should show task board functionality
```

### Model Integration Validation
```bash
# Verify Anthropic OAuth profiles
ls -la apps/macos/Sources/OpenClaw/AnthropicOAuth.swift

# Check model resolution integration
grep -r "anthropic.*profile" src/agents/
```

## Emergency Rollback Procedures

### If Merge Breaks Core Functionality
```bash
# Immediate rollback
git reset --hard pre-upstream-sync-2026.2.16

# Push rollback to all remotes
git push helios main --force-with-lease
git push gitea main --force-with-lease

# Note: --force-with-lease prevents overwriting others' work
```

### If Only Specific Features Break
```bash
# Revert specific merge commits (if merge created merge commit)
git log --oneline --merges -5  # Find merge commit
git revert -m 1 MERGE_COMMIT_HASH  # Revert merge

# Then selectively re-apply our custom work
git cherry-pick <our-commit-range>
```

## Backup Verification

### Verify Safety Assets Exist
```bash
# Check tag exists
git tag -l | grep pre-upstream-sync-2026.2.16

# Check backup branch exists  
git branch -a | grep backup/pre-upstream-sync

# Verify pushed to gitea
git ls-remote gitea | grep "pre-upstream-sync-2026.2.16"
git ls-remote gitea | grep "backup/pre-upstream-sync"
```

### Verify Commit Count
```bash
# Should show 62 commits ahead
git log --oneline pre-upstream-sync-2026.2.16 ^origin/main | wc -l
```

## Testing After Recovery

### Automated Tests
```bash
# Run cortex tests
cd extensions/cortex/python && python3 -m pytest

# Run core tests if available
npm test  # or whatever test command exists

# Run specific feature tests
cd extensions/cortex/python && python3 test_helios_monitor.py
```

### Manual Verification Checklist

- [ ] Cortex memory operations work (add, search, retrieve)
- [ ] Brain.db file exists and is populated
- [ ] SYNAPSE v2 protocol responds
- [ ] LBF task board tool is available  
- [ ] Anthropic OAuth profiles load correctly
- [ ] Working memory sync functions
- [ ] Atomic knowledge extraction works
- [ ] Extensions load without errors

## Contact Points

If recovery fails and expert help is needed:
- **Pre-merge state**: Always available at `pre-upstream-sync-2026.2.16`
- **Documentation**: This file and `CUSTOM_WORK.md`
- **File listing**: See `CUSTOM_WORK.md` for complete file inventory

## Final Safety Notes

1. **Never force-push** without `--force-with-lease`
2. **Always verify** the safety tag exists before attempting merge
3. **Test incrementally** after each recovery step
4. **Document any new issues** encountered during recovery
5. **Keep safety assets** until merge is fully validated and stable

The safety tag `pre-upstream-sync-2026.2.16` contains the complete, working state of all 62 custom commits. As long as this tag exists, complete recovery is always possible.