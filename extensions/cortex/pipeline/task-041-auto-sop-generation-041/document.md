# task-041-auto-sop-generation-041 — document

- Status: pass
- Date: 2026-02-24

## What this adds (MVP)

The **Auto-SOP Generation Engine** is a proposal-only subsystem for Cortex that:

- observes repeated _successful_ executions (initially: Cortex pipeline artifacts + pipeline state)
- clusters them into stable “procedures” via a deterministic **signature**
- emits **SOP proposals** as **new artifacts** (no mutation of enforced SOPs)
- delivers proposal summaries via **Synapse**
- enforces a hard governance rule: **requires human validation** before any SOP can become active

This stage documents the intended operator/developer workflow and the on-disk contracts (schemas + paths) that later build/test stages will implement.

---

## Operator workflow (end-to-end)

1. Run the generator (future build stage wires this into a CLI command).
2. Review proposed SOP artifacts under `extensions/cortex/sop-proposals/`.
3. Human validates and (in a future task) explicitly promotes the proposal into an enforced SOP.

**Important:** The generator must never auto-activate SOPs. This task is strictly the _recommendation pipeline_.

---

## Inputs (evidence sources)

MVP evidence sources (read-only):

- Pipeline task artifacts:
  - `extensions/cortex/pipeline/task-*/(requirements|design|document|build|security|test|deploy|done).md`
- Pipeline state transitions:
  - `extensions/cortex/pipeline/state.json`
- Optional later (not required for MVP): stage completion logs

All inputs are treated as **untrusted text**. The generator must normalize and escape content and must **never execute** extracted commands.

---

## Outputs (proposal artifacts)

Each detected procedure produces **two files**:

1. `extensions/cortex/sop-proposals/<signature>/proposal.md`
2. `extensions/cortex/sop-proposals/<signature>/proposal.json`

Where `<signature>` is a stable 12-hex prefix derived from normalized evidence.

### Signature rules (deterministic + idempotent)

MVP signature components:

- `scope`: fixed `cortex-pipeline`
- `stage`: pipeline stage when applicable (`build`, `test`, `deploy`, etc.)
- `procedure_commands`: extracted + normalized command list (order preserved)
- `invariants`: canonical repo-relative paths referenced

Signature computation:

- `signature_payload = stable-json({scope, stage, procedure_commands, invariants})`
- `signature = sha256(signature_payload).slice(0, 12)`

This enables:

- **de-duplication** (same signature → same directory)
- **idempotent reruns** (update-in-place by signature)

---

## proposal.json schema (contract)

Minimal contract fields (MVP):

- `schema_version`: `"1.0"`
- `signature`: 12-hex
- `signature_payload`: the exact payload hashed (auditable)
- `title`: human readable
- `mode`: `"recommendation_only"`
- `requires_human_validation`: `true`
- `created_at`, `updated_at`: ISO timestamps
- `confidence`:
  - `evidence_count`
  - `threshold` (default `3`, configurable)
- `preconditions`: repo/tools/permissions
- `procedure.steps`: step list (command or note)
- `verification.checks`: commands + expected outcomes
- `failure_modes`: symptom/diagnosis/remediation/rollback
- `evidence[]`: pointers back to source artifacts and excerpt hashes

### proposal.md rendering (human-first)

`proposal.md` is rendered from `proposal.json` and must include:

- a governance banner stating **recommendation-only** and **requires human validation**
- preconditions
- step-by-step procedure
- verification checks
- failure modes + rollback guidance
- evidence table with repo-relative paths

---

## Evidence extraction (MVP heuristic)

From markdown artifacts, extract likely shell commands from:

- fenced code blocks labeled `bash|sh|shell`
- lines beginning with common command prefixes (`cd`, `pnpm`, `npm`, `node`, `tsc`, `pytest`, `./`)

Normalize commands to stabilize signatures:

- trim, collapse whitespace
- strip leading `$ `
- replace volatile tokens:
  - commit SHAs → `<sha>`
  - timestamps → `<time>`
  - absolute home paths → `~/<path>`

This heuristic is intentionally conservative to avoid accidentally treating prose as executable steps.

---

## Synapse delivery contract

A Synapse message is emitted when:

- a proposal is newly created, OR
- evidence crosses milestones (e.g. `3 → 5 → 10`), OR
- proposal content materially changes

Message must include:

- proposal title + signature
- `mode=recommendation_only`
- `requires_human_validation=true`
- evidence_count + threshold
- file paths to `proposal.md` and `proposal.json`

---

## Governance and safety guarantees

Hard rules for MVP:

- **No enforcement changes.** Generator writes proposals only.
- **No destructive writes.** Only create/update files under `extensions/cortex/sop-proposals/`.
- **No command execution.** Extracted commands are text only.
- **Path safety.** Reads/writes must be path-resolved and constrained to allowlisted directories.

---

## Acceptance (document stage)

- [x] Documented inputs and outputs
- [x] Documented signature/idempotency rules
- [x] Documented proposal schemas (JSON + MD)
- [x] Documented Synapse delivery expectations
- [x] Documented governance invariants (human validation gate)
