# Security Review — task-028-shared-cortex-expansion-028

- Status: pass
- Date: 2026-02-21
- Phase: 3.2
- Task: Shared Cortex Expansion 028 (planned expansion + hardening)

## Scope

Security assessment of the **design** in `design.md` for Shared Cortex:

- `SharedContextSnapshot` (parent → sub-agent inheritance / read)
- `CandidateContribution` (sub-agent → parent contribution / write)
- Conflict handling, dedupe/idempotency, provenance, and redaction

This is a design-stage security review (no new code shipped in this task). The goal is to ensure the design is safe to implement and difficult to misuse.

## Trust boundaries

1. **Parent session** (trusted authority)
   - Owns working-memory pins and decides what is accepted into STM.
2. **Sub-agent session** (partially trusted)
   - May be honest-but-buggy or compromised; can attempt to flood/poison.
3. **External/untrusted inputs** (hostile)
   - Webhooks / inbound content must never directly trigger state change.
4. **Persistence surfaces**
   - Cortex STM / brain.db (durable knowledge) and any queue/audit store.
5. **Coordination surface**
   - Synapse thread messages (audit trail; potential leakage if content is not scrubbed).

## Assets to protect

- Secrets in parent context (API keys, bearer tokens, private keys, vault refs, local paths that imply sensitive structure)
- Integrity of pinned/working-memory facts (must not be overwritten silently)
- Integrity of Cortex STM (avoid poisoning and spam)
- Confidentiality of inherited context (least privilege + bounded payload)
- Operational reliability (fail-closed; no partial writes; no runaway payload sizes)

## Threat model (attacker goals)

- **Exfiltrate** secrets by inducing inheritance packets to include sensitive text
- **Policy bypass**: trick sub-agent or pipeline into “accepting” untrusted contributions automatically
- **Poisoning**: inject false memories with high confidence/categories to influence later behavior
- **Denial of service**: flood contribution channel or cause large inheritance snapshots
- **Forensic evasion**: submit content without provenance, making later debugging impossible

## Findings & recommendations

### F1 — Inheritance snapshot can leak secrets without a mandatory scrubber

**Risk:** Medium→High (depends on what is present in STM/working-memory).

The design requires provenance and bounded size, but it does not _mandate_ a secret-redaction pass for inherited `items[].content`.

**Recommendation (must before runtime enablement):**

- Introduce a **mandatory** `redactSecrets(text)` (or `safe_text`) step before any content is placed into `SharedContextSnapshot.items`.
- Log redaction summary only (counts/types), not the raw secrets.

**Verification hook:**

- Unit tests with representative secret fixtures:
  - `sk-...`, `Bearer ...`, `BEGIN ... PRIVATE KEY`, long base64-ish tokens
  - ensure output replaces with `[REDACTED]`.

### F2 — Contribution ingestion must be “Synapse-only” by default (no auto-write)

**Risk:** High if auto-ingestion is enabled.

Design allows future “persisted queue” and eventual ingestion into STM. The key security control is that **external/untrusted** content and **sub-agent** content should not become durable STM without a parent acceptance decision.

**Recommendation:**

- Hard rule: `CandidateContribution` is **non-authoritative** until accepted by a trusted parent action.
- If implementing an automated accept path later, require:
  - explicit allowlist of categories eligible for auto-accept
  - minimum confidence threshold
  - proof of evidence pointers (and optionally verification checks)
  - rate limits per session

**Forensics signature:**

- Any STM write sourced from a contribution must log:
  - `contribution_id`, `from_session`, `accepted_by`, and resulting `stm_id`.

### F3 — Dedupe logic can be gamed (whitespace/case normalization is insufficient)

**Risk:** Medium.

The proposed normalization (trim/collapse whitespace/lowercase) reduces repeats but does not prevent trivial bypasses (synonyms, reordering, punctuation).

**Recommendation:**

- Keep the stable `content_hash` but add a second-layer “near-dup” detector:
  - similarity against recent accepted items (embedding distance or fuzzy hash)
  - bounded window (e.g., last N accepted contributions)
- Apply rate limits regardless of dedupe results.

### F4 — Conflict detection must be conservative; never overwrite pinned facts

**Risk:** Medium.

The design correctly states “no silent overwrite,” but conflict detection is heuristic and may miss contradictions.

**Recommendation:**

- Treat conflict detection as **advisory** only; even “clean” contributions must not overwrite.
- If an acceptance workflow edits/updates existing memories, require:
  - a diff preview
  - explicit “supersedes” metadata
  - retention of prior statement + provenance

### F5 — Evidence pointers may leak sensitive file paths / environment structure

**Risk:** Medium.

`evidence[]` allows `path` and `command_output`, which can expose home directories, repo layout, hostnames, and secrets in logs.

**Recommendation:**

- Apply redaction to `evidence[].value` as well.
- Prefer relative paths within repo/workspace.
- For `command_output`, store only a short excerpt + hash pointer to full output saved locally (if needed).

### F6 — Model override / routing safety (downstream)

**Risk:** Low→Medium.

This task’s design references scoped inheritance and contributions; it does not directly address model routing. However, shared context and contributions are a common vector for “please use model X / provider Y” prompt injections.

**Recommendation:**

- Enforce model/provider allowlists at the execution boundary.
- Record _source_ of model override decisions in logs (`user`, `policy`, `external_untrusted`, `subagent`).

## Positive controls in the design

- **Bounded inheritance** target (<~50KB) limits accidental leakage and cost.
- **Provenance-first** item records enable later audit and rollback.
- **No silent overwrite** principle aligns with pinned working-memory integrity.
- **Greppable forensics signatures** specified in `design.md`.

## Required follow-ups before enabling in production

1. Implement mandatory secret redaction for both inheritance snapshots and contributions (including evidence fields).
2. Make “Synapse-only, manual accept” the default; no auto-write to STM.
3. Add rate limiting + near-duplicate detection to prevent flooding.
4. Ensure all accept/reject actions produce durable audit signatures.

## Stage result

- Status: **pass** (design-stage security review completed)
- Notes: Findings F1/F2 are **blockers** for any future auto-ingestion; they must be addressed before wiring this into a live shared-cortex runtime path.
