# task-041-auto-sop-generation-041 — requirements

- Status: pass
- Date: 2026-02-24

## Objective

Design the minimum viable **Auto-SOP Generation Engine** for Cortex: detect repeated successful execution patterns and generate **SOP proposals** (recommendations) that are delivered via **Synapse**, with explicit **human validation gates**.

This system is intended to _assist_ operational maturity by proposing new/updated SOPs; it must not silently mutate enforcement behavior.

## Scope

### In scope

1. Observe repeated successful task executions and extract stable, reusable steps.
2. Produce a structured SOP proposal artifact (markdown + machine-readable metadata).
3. Deliver proposals to Synapse (as the default routing mechanism).
4. Require human validation before any SOP is activated/enforced.

### Out of scope (for MVP)

- Automatic promotion of proposals into enforced SOPs.
- Autonomous edits to existing SOPs without review.
- Cross-repo SOP generation (limit to Cortex pipeline + extension runtime artifacts initially).

## Functional Requirements

### R1 — Input sources

The engine MUST support deriving candidate SOPs from at least these sources:

- Pipeline task artifacts (e.g. `pipeline/task-*/(requirements|design|build|test|deploy).md`).
- Pipeline stage outcomes / state transitions (`pipeline/state.json`).
- Structured run metadata (where available) such as stage completion logs and error classifications.

### R2 — Pattern detection

The engine MUST detect repeated successful patterns by grouping executions using a signature comprised of:

- task/stage identifiers (e.g. `task-040`, `build`)
- command sequences (when available)
- invariant file paths / artifacts
- normalized environment assumptions (node/pnpm versions, cwd)

The grouping MUST tolerate benign variance (timestamps, commit SHAs, hostnames).

### R3 — Proposal generation

For any pattern that meets a configurable threshold (e.g. N successful repeats), the engine MUST generate a proposal that includes:

- Title + short rationale
- Preconditions (required tools, repo location, permissions)
- Step-by-step procedure (commands + expected outputs)
- Verification checks (how to confirm success)
- Failure modes + rollback guidance
- Confidence / evidence summary (links to runs/artifacts)

### R4 — Delivery via Synapse

- The engine MUST deliver the proposal via Synapse as a message containing:
  - a summary
  - a link/path to the full proposal artifact
  - explicit callout that this is **recommendation-only** and requires human validation

### R5 — Governance: human validation gate

- Proposals MUST be tagged as `recommendation_only` by default.
- Proposals MUST include an explicit field indicating `requires_human_validation=true`.
- No enforcement or automated SOP activation is permitted without a separate, explicit approval step.

### R6 — Idempotency and safety

- Generation MUST be non-destructive: writing new proposal files only.
- Re-running MUST NOT spam duplicates; proposals should be de-duplicated by signature and updated in-place when evidence grows.

## Non-Functional Requirements

- Deterministic outputs given the same inputs (stable sorting, normalized fields).
- Clear separation between:
  - observation / proposal (this task)
  - enforcement / gating (future task)
- Traceability: every proposal MUST reference source evidence.

## Acceptance Criteria

- A `requirements.md` artifact exists for this task.
- Requirements specify: sources, patterning, proposal schema, Synapse delivery, and human-validation governance.
- Pipeline `state.json` and `task.json` reflect `requirements` completion with an artifact pointer.
