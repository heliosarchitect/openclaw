# task-028-shared-cortex-expansion-028 — requirements

- Status: pass
- Date: 2026-02-21
- Phase: 3.2
- Task: Shared Cortex Expansion 028 (planned expansion + hardening)

## 0) Context / intent

This task is one of a batch of “Shared Cortex Expansion” items intended to incrementally harden the **shared Cortex** capability introduced earlier (parent ↔ sub-agent knowledge sharing, controlled contribution, and predictable inheritance semantics).

This stage captures **requirements** (what must be true) rather than design or implementation details.

## 1) Objectives

1. **Stability-first expansion:** expand shared Cortex behaviors without regressing existing agent workflows (memory add/edit/dedupe/move, synapse coordination, session persistence).
2. **Deterministic inheritance semantics:** sub-agents can read inherited context with clear precedence and provenance.
3. **Safe contribution path:** sub-agents can contribute candidate learnings back to the parent context with guardrails (validation metadata, provenance, and rate-limits).
4. **Forensic operability:** changes must remain greppable/debuggable via Matthew’s Version Forensics framework.

## 2) Scope

### In scope

- Requirements for shared knowledge **read** (inherit) and **write** (contribute) flows.
- Requirements for provenance, confidence, and conflict handling.
- Requirements for observability and “forensic trail” (log signatures + rollback safety).

### Out of scope (explicit)

- New external integrations (no new providers, no new remote DBs).
- UI/UX changes (no new dashboards required).
- Large-scale schema migrations beyond additive fields.

## 3) Actors / surfaces

- **Parent agent (main session):** owns the canonical working context and decides what is pinned/accepted.
- **Sub-agent (isolated session):** consumes inherited context; produces findings.
- **Cortex memory store (STM + embeddings/atoms):** persistent store of learnings.
- **Synapse:** coordination/messaging layer to return results and metadata.

## 4) Functional requirements

### FR-1: Inherited context read

- Sub-agents MUST be able to read an **explicitly scoped** subset of parent context.
- Inheritance MUST include provenance metadata:
  - source session/task
  - timestamp
  - confidence/importance
  - category tags
- Inheritance MUST support **filtering**:
  - by category/categories
  - by minimum importance
  - by recency window
  - by explicit “pinned”/“always include” set (working memory)

### FR-2: Contribution write (candidate learnings)

- Sub-agents MUST be able to submit candidate learnings to the parent workflow.
- Each contribution MUST include:
  - `content`
  - `proposed_categories`
  - `confidence` (0–1)
  - provenance (source agent/session, inputs used)
  - evidence pointers when applicable (paths, URLs, command outputs)
- The system MUST support **review/accept** semantics (even if implemented as “append-only + later dedupe”), such that the parent can:
  - accept → store in Cortex STM (and optionally atomize)
  - reject → keep as an audit record (optional) without polluting STM

### FR-3: Conflict handling

- When a contribution conflicts with existing pinned/working-memory facts, the system MUST:
  - preserve both statements with provenance, OR
  - mark the new statement as “conflicting/unverified”
- The system MUST NOT silently overwrite pinned facts.

### FR-4: Idempotency / dedupe friendliness

- Repeated submissions of the same contribution SHOULD be detectable (hash/content similarity) to prevent STM spam.
- Requirements artifacts SHOULD reference prior task IDs rather than duplicating entire prior docs.

### FR-5: Threaded coordination

- Work products SHOULD be attributable to a single task thread (Synapse thread_id) to maintain a continuous audit trail.

## 5) Non-functional requirements

### NFR-1: Reliability

- Shared Cortex operations MUST fail closed (no partial writes that corrupt state).
- If inheritance/contribution fails, sub-agent execution MUST still complete with a clear error payload for diagnosis.

### NFR-2: Performance

- Inheritance payload size MUST be bounded (target: < ~50KB text unless explicitly expanded).
- Contribution submission MUST be lightweight and not block tool loops.

### NFR-3: Security / privacy

- Contributions MUST NOT exfiltrate secrets (tokens, private keys). Any automated ingestion path MUST support redaction/filters.
- Only explicitly authorized sub-agents SHOULD receive inherited context (session-scoped permissions).

### NFR-4: Forensics (Version Forensics Framework)

- Any behavior change MUST ship with:
  - behavioral signature (expected log patterns)
  - failure mode signature
  - debugging hooks (grep commands)
  - rollback plan

## 6) Compatibility / constraints

- MUST remain compatible with existing Cortex operations (add/edit/update/move/dedupe) and the brain.db storage model.
- MUST remain compatible with OpenClaw session + synapse orchestration.
- Prefer additive changes; avoid destructive migrations.

## 7) Acceptance criteria

- A sub-agent run can:
  1. receive inherited context with provenance
  2. produce a candidate learning payload with confidence
  3. deliver it back (via coordination layer) without corrupting STM
- Conflicts are surfaced (not overwritten).
- Logs provide a greppable trace for:
  - “inherit start/end”
  - “contribution submitted”
  - “accepted/rejected/queued”

## 8) Deliverables of this stage

- This `requirements.md` documenting the expansion’s required behaviors, constraints, and acceptance criteria.

## 9) Notes

This task is part of a **batch ship** intended to keep the pipeline moving through task-039. The requirements are therefore written to be _general_ and _stable_, and are expected to be refined by later design/build stages when concrete deltas are selected.
