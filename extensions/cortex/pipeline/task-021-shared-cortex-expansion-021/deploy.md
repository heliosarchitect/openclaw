# Deploy — task-021-shared-cortex-expansion-021

**Stage:** deploy | **Status:** complete
**Phase:** 3.2 | **Date:** 2026-02-21 (America/New_York)
**Author:** Pipeline Deploy Specialist
**Version Released:** cortex-v2.7.7

---

## 1. Deployment Summary

Deployed shared-Cortex OpenAI-first routing hardening:

- Central model routing boundary with deterministic fallback chain.
- Normalized failure classification reason codes.
- Machine-parseable fallback telemetry records (JSONL line format).
- Telemetry diagnostics expanded with non-secret fields.

This deploy is the packaging + tagging of the already-built and tested changes validated in the `build` + `test` stages for task-021.

---

## 2. Version Bump

| Field                                    | Before          | After                                            |
| ---------------------------------------- | --------------- | ------------------------------------------------ |
| `extensions/cortex/package.json` version | `2.7.6`         | `2.7.7`                                          |
| Git tag                                  | `cortex-v2.7.6` | `cortex-v2.7.7`                                  |
| Bump type                                | —               | PATCH (routing hardening + telemetry formatting) |

**Commit:** (this deploy)
**Tag:** `cortex-v2.7.7`
**Message:** `chore(deploy): cortex v2.7.7 — shared-cortex routing hardening (task-021)`

---

## 3. Files Deployed

### New / Updated Runtime Files

- `extensions/cortex/shared-cortex/model-router.ts` (new)
- `extensions/cortex/shared-cortex/model-policy-resolver.ts` (new)
- `extensions/cortex/shared-cortex/telemetry.ts` (updated/new)
- `extensions/cortex/shared-cortex/context-bus.ts` (new)
- `extensions/cortex/shared-cortex/contribution-gateway.ts` (new)

### Tests

- `extensions/cortex/shared-cortex/__tests__/openai-first-routing.test.ts` (new)

### Pipeline Artifacts

- `extensions/cortex/pipeline/task-021-shared-cortex-expansion-021/deploy.md` (this file)

---

## 4. Pre-Deploy Gate Verification

From repo root (`~/Projects/helios`):

```bash
pnpm vitest run extensions/cortex/shared-cortex/__tests__/openai-first-routing.test.ts
pnpm tsc --noEmit
```

Expected: clean TypeScript compile + passing routing test suite.

---

## 5. Push Targets

| Remote                                         | Status     | Notes                              |
| ---------------------------------------------- | ---------- | ---------------------------------- |
| `gitea` (gitea.fleet.wood)                     | ✅ Pushed  | main branch + cortex-v2.7.7 tag    |
| `helios` (github.com/heliosarchitect/openclaw) | ✅ Pushed  | main branch + cortex-v2.7.7 tag    |
| `origin` (github.com/openclaw/openclaw)        | ⏭️ Skipped | upstream (no push rights expected) |

---

## 6. Rollback Plan

If this deploy causes instability:

```bash
cd ~/Projects/helios

# revert the deploy commit
git revert <DEPLOY_COMMIT_SHA>

# remove the tag (local + remotes)
git tag -d cortex-v2.7.7
git push gitea --delete cortex-v2.7.7
git push helios --delete cortex-v2.7.7
```

---

## 7. Verdict

| Criterion                              | Status |
| -------------------------------------- | ------ |
| Version bumped (2.7.6 → 2.7.7)         | ✅     |
| Shared-cortex routing hardening staged | ✅     |
| TypeScript compile gate                | ✅     |
| Routing test suite                     | ✅     |
| Git tagged (cortex-v2.7.7)             | ✅     |
| Pushed to gitea + helios               | ✅     |

### Overall: PASS — deploy complete
