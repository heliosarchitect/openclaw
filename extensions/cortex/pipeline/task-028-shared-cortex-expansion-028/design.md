# task-028-shared-cortex-expansion-028 — design

- Status: pass
- Date: 2026-02-21
- Phase: 3.2
- Task: Shared Cortex Expansion 028 (planned expansion + hardening)

## 0) Design intent

Turn the requirements from `requirements.md` into a concrete, implementable design for:

- **inherit (read)**: sub-agents consume a scoped, provenance-rich slice of parent context
- **contribute (write)**: sub-agents submit candidate learnings back with guardrails
- **forensics**: all flows are greppable, idempotent-friendly, and fail-closed

This design intentionally stays **additive** and avoids large migrations.

---

## 1) Proposed components

### 1.1 SharedContextSnapshot (read payload)

A bounded, structured payload delivered to sub-agents at spawn-time or on-demand.

**Shape (logical):**

- `snapshot_id`: string (uuid or hash)
- `created_at`: ISO timestamp
- `source_session`: parent session key/label
- `scope`: { categories, min_importance, recency_window, include_working_memory }
- `items[]`: array of context records (see below)
- `redactions[]`: any redaction rules applied
- `limits`: { max_chars, max_items }

**Item record (logical):**

- `content`: string
- `categories[]`: string
- `importance`: number
- `confidence`: number | null
- `provenance`:
  - `origin`: 'working_memory' | 'stm' | 'atom' | 'embedding' | 'manual'
  - `source`: session/task identifier
  - `memory_id`/`atom_id`: optional
  - `created_at`: timestamp

**Bounded size target:** < ~50KB of text (hard cap configurable).

### 1.2 CandidateContribution (write payload)

A structured submission from sub-agent → parent for review.

**Shape (logical):**

- `contribution_id`: string (uuid)
- `submitted_at`: ISO timestamp
- `from_session`: sub-agent session key/label
- `thread_id`: synapse thread id
- `content`: string
- `proposed_categories[]`: string
- `confidence`: number (0..1)
- `evidence[]`: array of pointers
  - `{ kind: 'path'|'url'|'command_output'|'note', value: string }`
- `inputs_used[]`: optional list of snapshot ids / refs
- `conflict_check`:
  - `status`: 'clean'|'potential_conflict'|'conflict'
  - `against`: optional identifiers of pinned facts / WM items
- `dedupe`:
  - `content_hash`: string (stable hash of normalized content)
  - `similarity_key`: optional (for fuzzy detection)
- `security`:
  - `redacted`: boolean
  - `redaction_notes`: optional

### 1.3 Parent-side ReviewQueue (minimal)

Design assumes the parent agent remains the final authority. Implementation can be either:

- **(A) Synapse-only review**: contributions arrive as messages; parent manually accepts/rejects.
- **(B) Persisted queue (preferred later)**: an append-only queue stored on disk (or in brain.db) with status transitions.

For this batch expansion task, we design around (A) and keep (B) as an extension.

---

## 2) Data sources and precedence (inherit semantics)

### 2.1 Precedence order (deterministic)

When constructing `SharedContextSnapshot.items`:

1. **Working memory pins** (highest precedence; always included when `include_working_memory=true`)
2. **High-importance STM memories**
3. **Recent STM memories** (within recency window)
4. **Optional atoms/embeddings summaries** (only if explicitly requested by scope)

### 2.2 Provenance requirements

Every included item MUST carry:

- origin type
- source session/task identifier
- timestamp

This enables:

- reproducibility
- conflict analysis
- audit trail

---

## 3) Contribution flow (sub-agent → parent)

### 3.1 Transport

Use **Synapse** as the default transport for candidate contributions.

- One Synapse thread per task (`thread_id=task-028-shared-cortex-expansion-028`).
- Parent can later ingest accepted contributions into Cortex STM.

### 3.2 Accept / reject semantics

Parent-side decisions (manual or future automated):

- **ACCEPT**
  - store into Cortex STM via `cortex_add` equivalent path (brain.db)
  - optionally atomize (future step)
  - record acceptance provenance: accepted_by, accepted_at, source contribution_id
- **REJECT**
  - do not store into STM
  - keep an audit trail in Synapse thread (or future queue DB) including rejection rationale

### 3.3 Dedupe and idempotency

To avoid STM spam:

- compute `content_hash = sha256(normalize(content))`
- if the same `content_hash` is seen within a configurable window (e.g., 24h) from the same `from_session`, mark as duplicate and suppress write to STM

Normalization rule (simple, stable):

- trim
- collapse whitespace
- lowercase

---

## 4) Conflict handling

### 4.1 Conflict detection heuristic

Before accept (or as a preflight on submission), compare `content` against **working memory** and other pinned facts.

- If semantic overlap suggests contradiction, mark `conflict_check.status='potential_conflict'`.

### 4.2 No silent overwrite

If conflict is detected:

- do not overwrite existing pinned facts
- accepted contributions should be stored with provenance and optionally tagged `conflict/unverified`

---

## 5) Redaction / secret safety

### 5.1 Redaction rules (baseline)

Prior to posting or storing contributions:

- apply regex-based redaction for common secret patterns:
  - `sk-...` API keys
  - `op://...` secret references
  - `BEGIN (RSA|OPENSSH) PRIVATE KEY`
  - long high-entropy tokens (configurable)

### 5.2 Fail-closed behavior

If redaction fails (e.g., redaction engine error), contributions should:

- still be delivered to Synapse, but with `security.redacted=false` and a clear warning, OR
- be blocked from automatic STM ingestion.

(Exact policy can be tuned; requirement is **no silent exfiltration**.)

---

## 6) Observability / Version Forensics hooks

### 6.1 Behavioral signatures (expected log patterns)

(Representative strings that should be emitted by whichever layer owns this feature.)

- `SHARED_CORTEX_INHERIT_START snapshot_id=... scope=...`
- `SHARED_CORTEX_INHERIT_DONE snapshot_id=... items=N chars=M`
- `SHARED_CORTEX_CONTRIBUTION_SUBMIT contribution_id=... hash=... confidence=...`
- `SHARED_CORTEX_CONTRIBUTION_ACCEPT contribution_id=... stm_id=...`
- `SHARED_CORTEX_CONTRIBUTION_REJECT contribution_id=... reason=...`
- `SHARED_CORTEX_CONFLICT_DETECTED contribution_id=... against=...`

### 6.2 Failure mode signatures

- `SHARED_CORTEX_INHERIT_FAIL ... error=...`
- `SHARED_CORTEX_CONTRIBUTION_FAIL ... error=...`
- `SHARED_CORTEX_REDACTION_FAIL ... error=...`

### 6.3 Debugging hooks (grep-friendly)

- `grep -R "SHARED_CORTEX_" -n ~/Projects/helios/extensions/cortex`
- `grep -R "CONTRIBUTION_" -n ~/Projects/helios/extensions/cortex`

---

## 7) Rollback plan

- All changes are additive and gated by feature flags / scope.
- Rollback strategy:
  1. disable inheritance snapshot generation
  2. disable automatic STM ingestion of contributions (leave Synapse-only audit)
  3. revert any additive fields if introduced (no destructive migration required)

---

## 8) Stage deliverables

- This `design.md` implementing a concrete, implementable design aligned to `requirements.md`.
