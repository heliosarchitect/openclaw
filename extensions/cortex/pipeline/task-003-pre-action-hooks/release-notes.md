# Release Notes — Cortex Extension v1.5.0

**Task ID**: task-003-pre-action-hooks  
**Stage**: deploy  
**Date**: 2026-02-18  
**Commit**: 2ec356bc5  
**Tag**: v1.5.0  
**Result**: ✅ DEPLOYED

---

## Summary

Cortex v1.5.0 ships the **Pre-Action Hook System** — a mandatory knowledge consultation layer that intercepts tool calls and forces SOP + memory lookup before execution. This closes Phase 1.1 of the IMPROVEMENT_PLAN ("Structural Enforcement Engine").

---

## What Changed

### New Files

| File                                         | Description                                                           |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `hooks/context-extractor.ts`                 | Extracts project/service/host/risk keywords from all tool call params |
| `hooks/sop-enhancer.ts`                      | 15 SOP patterns with 30min LRU cache, priority-sorted results         |
| `hooks/enforcement-engine.ts`                | Advisory/strict/category enforcement with cooldown + bypass tokens    |
| `hooks/knowledge-discovery.ts`               | KnowledgeDiscovery coordinator (parallel lookup orchestration)        |
| `config/pre-action-hooks.json`               | Full enforcement configuration schema                                 |
| `hooks/__tests__/context-extractor.test.ts`  | 21 unit tests                                                         |
| `hooks/__tests__/sop-enhancer.test.ts`       | 8 unit tests                                                          |
| `hooks/__tests__/enforcement-engine.test.ts` | 13 unit tests                                                         |

### Modified Files

| File               | Change                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `cortex-bridge.ts` | Added `searchMemoriesWithConfidence()` — multi-category memory search with confidence filtering |
| `index.ts`         | Replaced v1.1.0 SOP hook with v2.0.0 Universal Pre-Action hook (lines 717-916)                  |
| `package.json`     | Version bumped: 1.3.0 → 1.5.0 (skipped 1.4.x to align with existing monorepo tags)              |

---

## Architecture

```
Tool Call
  → ContextExtractor.extract()         # project/service/host/risk keywords
  → Parallel (150ms timeout):
      ├─ SOPEnhancer.findMatches()      # SOP pattern matching + content extraction
      └─ bridge.searchMemoriesWithConfidence()  # cortex memory lookup
  → EnforcementEngine.shouldBlock()    # advisory / strict / category decision
  → block (STRICT) or inject + allow (ADVISORY)
  → writeMetric()                      # tamper-evident audit trail
```

---

## Enforcement Modes

| Mode       | Behavior                                                                          |
| ---------- | --------------------------------------------------------------------------------- |
| `disabled` | Hook runs silently, no injection, no blocking                                     |
| `advisory` | Injects knowledge context into agent reasoning, never blocks                      |
| `strict`   | Blocks execution when relevant knowledge exists and hasn't been acknowledged      |
| `category` | Strict for specified categories (e.g. `process`, `security`), advisory for others |

**Default config**: `advisory` mode, intercepts `exec` and `nodes`.

---

## Quality Metrics

| Metric          | Result                                                              |
| --------------- | ------------------------------------------------------------------- |
| Tests           | 44/44 passing                                                       |
| TypeScript      | 0 errors (pnpm tsc --noEmit)                                        |
| Security        | 0 CRITICAL, 0 HIGH findings                                         |
| Security MEDIUM | 2 (both mitigated by architecture, fixes scheduled v1.5.1)          |
| Performance     | 150ms hard timeout on lookup; SOP cache sub-ms on repeated patterns |

---

## Known Issues (next patch v1.5.1)

- **MED-001**: `Math.random()` bypass token → replace with `crypto.randomBytes(16)`
- **MED-002**: Unescaped section names in RegExp → add `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` escaping
- **SERVICE_MAP**: `ft991a-control` keyword not mapped → cosmetic gap, SOPEnhancer regex still matches

---

## Deployment Checklist

- [x] `pnpm tsc --noEmit` — 0 errors
- [x] 44/44 tests passing
- [x] Security review approved (0 CRITICAL/HIGH)
- [x] Committed: `2ec356bc5`
- [x] Tagged: `v1.5.0`
- [x] Pushed to Gitea (gitea.fleet.wood/Helios/openclaw)
- [x] Pushed to GitHub (heliosarchitect/openclaw)
- [ ] LBF Project Registry Google Sheet updated (manual step)

---

**Deployed by**: Pipeline Deploy Specialist  
**Pipeline task**: task-003-pre-action-hooks  
**Closes**: Phase 1.1 — Structural Enforcement Engine
