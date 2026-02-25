# task-041-auto-sop-generation-041 — design

- Status: pass
- Date: 2026-02-24

## Design intent

Deliver an MVP **Auto-SOP Generation Engine** that observes repeated _successful_ executions, extracts stable procedure candidates, and emits **recommendation-only SOP proposals**.

Hard constraints from requirements:

- Non-destructive: write _new_ proposal artifacts only.
- Deterministic and traceable: every proposal links to evidence inputs.
- Governance: **requires human validation** before any SOP becomes active/enforced.
- De-duplication: reruns must update/append evidence without spamming duplicates.
- Delivery: announce proposals via **Synapse**.

## Conceptual architecture

Split into three strictly separated concerns:

1. **Observation** (read-only)

- Collect candidate evidence from pipeline artifacts + state transitions.
- Normalize raw inputs into a canonical, stable representation.

2. **Proposal generation** (write-only to proposal directory)

- Convert clustered evidence → a proposal document + metadata.
- Use a stable signature so proposals are idempotent.

3. **Governance / Activation** (explicitly out of scope)

- No automatic SOP activation.
- Any future activation flow must be a separate command + reviewed PR.

## Data flow

### Inputs (MVP)

- Pipeline task artifacts under:
  - `extensions/cortex/pipeline/task-*/(requirements|design|document|build|security|test|deploy|done).md`
- Pipeline state transitions:
  - `extensions/cortex/pipeline/state.json`
- Optional: stage completion logs (if present later)

### Output artifacts

A proposal is represented by **two files**:

1. Markdown proposal document

- Path:
  - `extensions/cortex/sop-proposals/<signature>/proposal.md`

2. Machine-readable metadata (JSON)

- Path:
  - `extensions/cortex/sop-proposals/<signature>/proposal.json`

Where `signature` is stable and derived from normalized evidence (details below).

### Delivery

- A Synapse message is emitted containing:
  - proposal title
  - key rationale + confidence/evidence count
  - path(s) to proposal artifacts
  - explicit note: **recommendation-only; requires human validation**

## Evidence model

### Normalization goals

We need to group “same procedure” even if:

- timestamps differ
- commit SHAs differ
- hostnames differ
- absolute paths differ in user home (e.g. `/home/bonsaihorn/...`)

### Canonical evidence record (internal)

```ts
type Evidence = {
  source_kind: "pipeline_artifact" | "pipeline_state" | "stage_log";
  task_id?: string; // e.g. task-041-auto-sop-generation-041
  stage?: string; // e.g. build
  artifact_path?: string; // repo-relative
  excerpt_hash?: string; // sha256 of excerpt used
  commands?: string[]; // extracted commands, normalized
  env?: {
    cwd?: string; // normalized to repo-relative when possible
    node?: string | null;
    pnpm?: string | null;
  };
  observed_at?: string; // informational; not used in signature
};
```

### Command extraction (MVP heuristic)

From markdown artifacts, extract shell-like lines that match:

- fenced code blocks labeled `bash|sh|shell`
- indented command blocks
- inline commands starting with common prefixes:
  - `cd `, `pnpm `, `npm `, `node `, `tsc `, `pytest `, `./`

Normalization rules:

- trim, collapse whitespace
- strip leading `$ `
- redact/replace:
  - commit SHAs → `<sha>`
  - ISO timestamps → `<time>`
  - absolute home paths → `~/<path>`

This is intentionally conservative: only commands we can identify with high confidence become part of the signature.

## Pattern detection / clustering

### Signature definition

A proposal signature MUST be deterministic and stable.

MVP signature components:

- `scope`: fixed `cortex-pipeline`
- `stage`: the pipeline stage (build/test/deploy/etc.) when applicable
- `procedure_commands`: normalized command list (order preserved)
- `invariants`: canonical artifact paths referenced (repo-relative)

Compute:

- `signature_payload = JSON.stringify({scope, stage, procedure_commands, invariants}, stableSortKeys=true)`
- `signature = sha256(signature_payload).slice(0, 12)`

Store both:

- `signature`
- `signature_payload` (in proposal.json) for auditability

### Thresholding

MVP: generate/refresh a proposal when there are at least:

- `N = 3` successful evidence observations for the same signature

(Keep N configurable; default lives in config, not code constants.)

### De-duplication / idempotency

- Proposal directory is keyed by `signature`.
- On rerun:
  - if proposal exists → append/merge evidence list (by excerpt_hash + artifact_path) and update confidence
  - else → create new proposal files

No duplicate Synapse spam:

- Emit Synapse only when:
  - proposal newly created, OR
  - evidence_count crosses a milestone (e.g. 3→5→10), OR
  - proposal content materially changes (hash changed)

## Proposal schema

### proposal.json

```json
{
  "schema_version": "1.0",
  "signature": "<12-hex>",
  "signature_payload": {
    "scope": "cortex-pipeline",
    "stage": "build",
    "procedure_commands": [],
    "invariants": []
  },
  "title": "<string>",
  "mode": "recommendation_only",
  "requires_human_validation": true,
  "created_at": "<iso>",
  "updated_at": "<iso>",
  "confidence": {
    "evidence_count": 0,
    "threshold": 3,
    "notes": "Evidence-weighted; deterministic given same inputs"
  },
  "preconditions": {
    "repo": "~/Projects/helios/extensions/cortex",
    "tools": ["node", "pnpm"],
    "permissions": []
  },
  "procedure": {
    "steps": [{ "kind": "command", "text": "pnpm -w install", "expect": "Dependencies installed" }]
  },
  "verification": {
    "checks": [{ "kind": "command", "text": "pnpm tsc --noEmit", "expect": "exit 0" }]
  },
  "failure_modes": [
    {
      "symptom": "<string>",
      "diagnosis": "<string>",
      "remediation": "<string>",
      "rollback": "<string>"
    }
  ],
  "evidence": [
    {
      "source_kind": "pipeline_artifact",
      "task_id": "task-040...",
      "stage": "build",
      "artifact_path": "pipeline/task-040.../build.md",
      "excerpt_hash": "<sha256>"
    }
  ]
}
```

### proposal.md

Human-first rendering from the JSON:

- Title + summary rationale
- Preconditions
- Steps
- Verification
- Failure modes + rollback
- Evidence table with paths
- Explicit governance banner: _recommendation-only; requires human validation_

## Integration points

### Where it runs (MVP)

A new pipeline/ops command (future build stage) can run:

- `pnpm cortex sop:generate` (name illustrative)

But for MVP design, the generator is designed as a pure function:

- `collectEvidence()` → `cluster()` → `materializeProposals()` → `deliverToSynapse()`

### Synapse delivery

Use existing Synapse client/utility used elsewhere in cortex (do not implement new network stack).
Message template:

- Subject: `SOP proposal: <title> [<signature>]`
- Body:
  - `mode=recommendation_only`
  - `requires_human_validation=true`
  - evidence_count + threshold
  - proposal paths

## Security / safety notes (design-level)

- Treat all artifact content as untrusted input; normalize/escape before rendering.
- Never execute extracted commands.
- Proposal write path is a fixed allowlisted directory under the repo:
  - `extensions/cortex/sop-proposals/`
- Resolve/validate paths before reads/writes to prevent traversal.

## Acceptance checklist (design)

- [x] Stable signature + idempotent storage layout
- [x] Deterministic normalization rules
- [x] JSON+MD output contracts
- [x] Synapse delivery contract (recommendation-only + human validation)
- [x] Explicit separation from enforcement/activation
