# task-041-auto-sop-generation-041 — security

- Status: pass
- Date: 2026-02-24

## Scope

Security review of the MVP Auto-SOP Generation Engine primitives added in build stage:

- `extensions/cortex/sop-generation/auto-sop-generator.ts`
- `extensions/cortex/sop-generation/__tests__/auto-sop-generator.test.ts`

The generator consumes pipeline artifacts/state (untrusted text), extracts command-like lines, and emits **recommendation-only** SOP proposal artifacts.

## Threat model (what can go wrong)

### Inputs are untrusted

Pipeline artifacts can contain:

- hostile markdown content
- misleading command strings
- path strings intended to cause file reads/writes outside the repo (path traversal)

### Outputs are semi-trusted

SOP proposals are meant for human consumption and later may influence enforcement in future phases. Therefore, proposal content must be:

- clearly marked as non-executable recommendations
- resistant to formatting injection that could hide/alter meaning

### Core safety constraint

The engine **must not execute** extracted commands. It should treat extracted commands as _data_.

## Findings

### ✅ Governance invariants present

- Proposal JSON includes:
  - `mode: "recommendation_only"`
  - `requires_human_validation: true`
- Markdown rendering includes an explicit governance banner.

This aligns with the “human validation gate” requirement and reduces risk of silent policy changes.

### ⚠️ Markdown formatting injection (medium)

`renderProposalMarkdown()` originally wrapped untrusted strings in inline code spans using backticks (e.g. `` `...` ``).
If an extracted command/evidence field contained backticks or newlines, it could:

- break formatting
- visually alter the proposal
- potentially hide parts of the procedure in rendered markdown

**Mitigation applied (code change):**

- Added `escapeInlineCode()` and `safeOneLine()` to sanitize strings before rendering into inline code.

### ⚠️ Unbounded file reads / path traversal risk (medium)

`loadAndHashEvidenceArtifact(artifactPath)` originally accepted an arbitrary path and performed `readFile()` with no boundary checks.
If later wired to accept user-controlled paths, this could become an arbitrary file read primitive.

**Mitigation applied (code change):**

- Changed API to `loadAndHashEvidenceArtifact({ repoRoot, artifactPath })` and enforced that `artifactPath` resolves within `repoRoot`.

### ℹ️ Denial of service via very large artifacts (low)

The extractor (`extractCommands`) reads full markdown content into memory and iterates line-by-line. Very large artifacts could increase CPU/memory usage.

**Recommendation:**

- When orchestration is added, cap artifact size for processing (e.g. max bytes) and/or stream line processing.

### ℹ️ Signature stability / collision risk (low)

Signature is a 12-hex prefix of SHA-256. Collision probability is low for expected scale, but non-zero.

**Recommendation:**

- Keep full SHA-256 in metadata (or lengthen prefix) if proposal count becomes large.

## Security posture summary

- No command execution occurs in the generator.
- Proposal output is explicitly recommendation-only.
- Added basic output sanitization and defensive path bounding for artifact hashing.

## Verification performed

- `pnpm vitest run extensions/cortex/sop-generation/__tests__/auto-sop-generator.test.ts` → pass
- `pnpm tsc --noEmit` → pass

## Follow-ups (not required for MVP)

- Add size limits + timeouts when collecting evidence from artifacts.
- Consider escaping/normalizing more markdown-special characters if proposals are later rendered in different surfaces.
- Centralize path safety helpers (shared util) as generator expands.
