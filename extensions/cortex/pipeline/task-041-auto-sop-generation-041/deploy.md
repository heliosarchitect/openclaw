# task-041-auto-sop-generation-041 — deploy

- Status: in_progress
- Date: 2026-02-25

## Release Plan

### Version bump

- Bump type: **minor** (new feature: Auto-SOP Generation Engine)
- From: `2.8.0`? (preflight checks below confirm prior tag)
- To: `2.8.0`
- Tag: `cortex-v2.8.0`

### Scope shipped in this release

- MVP **Auto-SOP Generation Engine** (proposal-only path)
  - deterministic command extraction + normalization
  - stable signature generation (SHA-256 → 12-hex prefix)
  - proposal JSON schema (`mode=recommendation_only`, `requires_human_validation=true`)
  - markdown rendering with inline-code escaping (backtick/newline hardening)
  - bounded evidence artifact hashing (refuse reads outside repoRoot)

### Deploy checklist

1. ✅ Version bump in `extensions/cortex/package.json`
2. ⏳ Update `extensions/cortex/CHANGELOG.md`
3. ⏳ Commit release changes
4. ⏳ Tag `cortex-v2.8.0`
5. ⏳ Push commit + tag
6. ⏳ Update LBF Project Registry Google Sheet

## Preflight Audit

Commands (ran locally):

```bash
cd ~/Projects/helios/extensions/cortex
cat package.json | jq -r '.version'
git tag --sort=-v:refname | grep '^cortex-v' | head -5
```

Expected:

- package.json version shows `2.8.0`
- latest existing tag is `cortex-v2.7.7` (or similar), then new tag created for `2.8.0`

## Notes

- This stage will mark itself **pass** only after commit + tag exist and registry update is attempted (or explicitly noted blocked).
