# Documentation — task-021-shared-cortex-expansion-021

## Purpose

This document defines **operational behavior** for hardening the Shared Cortex OpenAI-first routing system:

- deterministic model selection and fallback
- machine-parseable fallback reason codes
- portability of hook/SOP tooling in constrained hosts (`python3`, `rg`→`grep` fallback)
- telemetry that **separates subscription vs api_key** routing

This is an implementation-facing contract for the subsequent build/test stages.

---

## 1) Model Routing (Single Boundary)

### 1.1 Central routing boundary

All model-bearing execution paths MUST go through a single routing wrapper (design name: `SharedModelRouter`).

**Why:** prevents drift from ad-hoc model strings, inconsistent fallback behavior, and missing observability.

**Contract:** callers provide:

- `task_id`
- `task_type` (`coding|orchestration|analysis|general`)
- `route_type` (`subscription|api_key`) — must be explicit when known
- optional `user_override_model` (ONLY when explicitly set by the user)

### 1.2 Deterministic model order

Default policy (OpenAI-first):

1. Primary: `openai-codex/gpt-5.3-codex`
2. Fallback 1: `openai/gpt-5.2`
3. Fallback 2: `openai/gpt-5o`

**Determinism rules**

- No probing / “best available” selection.
- Given the same inputs and failure classes, fallback decisions are stable.
- If all attempts fail, return the final error but persist telemetry for each attempt.

### 1.3 Resolution order

When selecting the first model, resolution order is:

1. `user_override_model` (explicit user intent)
2. task policy mapping (if present)
3. system default (`openai-codex/gpt-5.3-codex`)

---

## 2) Fallback Reason Codes (Machine-Parseable)

### 2.1 Required finite set

Every fallback transition MUST emit exactly one reason code from:

- `timeout`
- `provider_5xx`
- `capacity`
- `policy_override`
- `none`

Notes:

- `none` is used when there was no fallback transition (initial attempt succeeded).
- Unknown failures MUST still map to one of the above (default to `capacity`) while adding `error_class` in telemetry.

### 2.2 JSONL log line (single line, parseable)

Emit one JSON line per fallback transition:

```json
{
  "event": "model_fallback",
  "task_id": "task-021-shared-cortex-expansion-021",
  "from": "openai-codex/gpt-5.3-codex",
  "to": "openai/gpt-5.2",
  "reason": "timeout",
  "route_type": "api_key"
}
```

Do not include secrets, raw provider payloads, or auth headers.

---

## 3) Portability Rules for Hooks & SOP Tooling

### 3.1 Python invocation

All docs, hooks, and internal scripts MUST assume `python3` (not `python`).

If a host lacks `python3`, that is considered an environment deficiency and should be reported clearly.

### 3.2 Search tool fallback (`rg` → `grep`)

Where documentation or scripts recommend repository search, they MUST support environments without ripgrep.

**Standard portable snippet**

```bash
if command -v rg >/dev/null 2>&1; then
  rg -n "PATTERN" path/
else
  grep -RIn --exclude-dir=node_modules --exclude='*.lock' -E "PATTERN" path/
fi
```

### 3.3 SOP enhancer resilience

Missing SOP files MUST be treated as **non-fatal**:

- if referenced SOP content is missing, proceed with minimal enforcement
- emit a structured warning for audit (but do not crash the pipeline)

---

## 4) Telemetry & Observability

### 4.1 Per-attempt capture

Telemetry MUST capture per attempt:

- `task_id`, `task_type`, `route_type`
- `selected_model`
- `attempt_index`, `attempt_count`
- `tokens_in`, `tokens_out` (if available)
- `duration_ms`
- `success`

### 4.2 Failure diagnostics (non-secret)

When a failure occurs, attach:

- `reason` (from the finite set)
- `error_class` (e.g., `TimeoutError`, `Provider5xx`, `Unknown`)

Never include API keys, bearer tokens, or raw request bodies.

### 4.3 Route type separation

Telemetry MUST separate **subscription** vs **api_key** execution:

- `route_type` should be passed explicitly by the calling context
- if unknown, default to `api_key` and emit a policy-audit note like `route_type_defaulted`

---

## 5) Operational Checks (Build/Test stage prerequisites)

Build/Test stages should validate:

1. A routing wrapper is the only allowed path to run provider calls / sub-agent spawns.
2. A fallback transition always produces a JSONL line with a valid reason code.
3. Missing `rg` does not break repo search flows (grep fallback works).
4. Missing `python` alias does not break flows (`python3` used everywhere).
5. Telemetry reports `route_type` explicitly and never logs secrets.

---

## 6) Documentation Stage Definition of Done

- `pipeline/task-021-shared-cortex-expansion-021/document.md` exists and documents:
  - deterministic model policy + fallback order
  - reason-code contract + JSONL example
  - `python3` + `rg`/`grep` portability requirements
  - telemetry fields including `route_type`
- Pipeline state advanced to `build`.
