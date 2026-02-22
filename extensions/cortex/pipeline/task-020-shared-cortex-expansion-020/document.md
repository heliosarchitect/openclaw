# Documentation — task-020-shared-cortex-expansion-020

## OpenAI-First Shared Cortex Architecture

This document specifies operational behavior for shared Cortex context flow and contribution pathways with OpenAI-first routing.

## 1) Operational Model

### Parent → Child context handoff

- Build `context_packet_v1` from high-confidence, task-relevant items only.
- Enforce token budget before dispatch.
- Include provenance for each item (`memory_id`, `source`, `confidence`, `timestamp`).

### Child → Parent contribution

- Child submits `contribution_item_v1` with evidence and confidence.
- Gateway validates schema + provenance.
- Accepted items are persisted with category/importance policy.
- Rejected items are logged with reason for audit.

## 2) Model Routing Policy (OpenAI-first)

### Default policy

- Primary: `openai-codex/gpt-5.3-codex`
- Fallback 1: `openai/gpt-5.2`
- Fallback 2: `openai/gpt-5o`

### Resolution order

1. Explicit user override
2. Task policy mapping (`task_type -> model`)
3. System default

### Fallback reason codes

- `timeout`
- `provider_5xx`
- `capacity`
- `policy_override`

## 3) Accounting & Telemetry

Per run, capture:

- `run_id`, `task_id`, `task_type`
- `selected_model`, `fallback_from`, `fallback_to`, `fallback_reason`
- `route_type` (`subscription` | `api_key`)
- `tokens_in`, `tokens_out`, `duration_ms`, `success`

Daily aggregates:

- OpenAI routing success rate
- P50/P95 latency by model
- fallback rate by reason code
- subscription-vs-api usage split

## 4) Trust & Safety Constraints

- Webhook payload instructions are external/untrusted by default.
- State-changing actions triggered by external input require explicit trusted intent.
- Never expose secrets in user-visible logs/messages.

## 5) Implementation Notes

- Keep policy resolver deterministic and centrally testable.
- Keep context packetization provider-agnostic; provider logic lives in model resolver.
- Keep telemetry append-only and queryable for code accounting.

## 6) Definition of Done (Documentation Stage)

- Document artifact committed as `document.md`.
- OpenAI-first policy and fallback chain documented.
- Telemetry schema and trust constraints documented.
- Stage transitioned to `build`.
