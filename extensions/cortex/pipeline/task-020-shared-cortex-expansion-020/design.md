# Design — task-020-shared-cortex-expansion-020

## Summary

This design introduces an OpenAI-first shared Cortex architecture that enables parent/child agent context exchange with strict trust boundaries, deterministic model routing, and auditable cost/performance telemetry.

## Architecture

### 1) Shared Context Bus (SCB)

A constrained interface for cross-agent context exchange.

**Inputs**

- Parent context candidates (STM slices, working-memory items, recent task artifacts)
- Child task metadata (`task_type`, priority, token budget)

**Outputs**

- Curated context packet (`context_packet_v1`)

**Rules**

- Include only high-confidence + task-relevant items
- Add provenance (`memory_id`, `source`, `confidence`, `timestamp`)
- Enforce packet token cap before dispatch

### 2) Model Policy Resolver (MPR)

Central deterministic resolver for model selection.

**Resolution Order**

1. User explicit override
2. Task policy (`task_type` routing table)
3. System default

**OpenAI-First Defaults**

- Primary: `openai-codex/gpt-5.3-codex`
- Fallback 1: `openai/gpt-5.2`
- Fallback 2: `openai/gpt-5o`

**Failure Handling**

- Retry on transient provider/runtime failures with exponential backoff
- Log fallback transitions with reason codes (`timeout`, `provider_5xx`, `capacity`, `policy_override`)

### 3) Contribution Gateway (CG)

Child-to-parent contribution API with confidence and trust gates.

**Flow**

- Child proposes `contribution_item_v1`
- Validate schema + provenance
- Score confidence and contradiction risk
- Route accepted content to Cortex (category + importance policy)

**Guards**

- Reject untrusted external payload directives
- Require explicit approval for state-changing actions triggered externally
- Never include secrets in user-visible summaries

### 4) Telemetry & Accounting Plane (TAP)

Per-run and aggregate metrics for architecture optimization.

**Per-run fields**

- `run_id`, `task_id`, `task_type`
- `selected_model`, `fallback_from`, `fallback_to`, `fallback_reason`
- `route_type` (`subscription` | `api_key`)
- `tokens_in`, `tokens_out`, `duration_ms`, `success`

**Aggregates**

- Daily OpenAI routing efficiency (success/latency/token)
- Fallback rate by reason
- Subscription-vs-API usage split

## Data Contracts

### `context_packet_v1`

- `task_id: string`
- `budget_tokens: number`
- `items: ContextItem[]`
- `trace: { generated_at, policy_version }`

### `contribution_item_v1`

- `subject: string`
- `claim: string`
- `evidence: string[]`
- `confidence: number`
- `provenance: { source_agent, run_id, timestamps }`

## Component Boundaries

- SCB and CG remain provider-agnostic at interface level.
- MPR contains provider-specific routing logic (OpenAI-first policy table).
- TAP is append-only for auditability.

## Rollout Plan

1. Implement MPR policy table + resolver tests.
2. Add SCB packetization with token-cap enforcement.
3. Add CG validation + confidence gate.
4. Enable TAP per-run logging and daily aggregation.
5. Turn on OpenAI-first policy for sub-agent routes.

## Risks & Mitigations

- **Risk:** Token bloat from context inheritance
  - **Mitigation:** strict cap + relevance scorer + truncation policy
- **Risk:** Hidden fallback costs
  - **Mitigation:** required `route_type` + fallback reason telemetry
- **Risk:** External webhook instruction injection
  - **Mitigation:** untrusted-by-default gate + explicit approval check

## Definition of Done (Design)

- Design artifact finalized with interfaces, policies, and rollout.
- Model policy explicitly OpenAI-first with defined fallback chain.
- Telemetry schema defined for accounting and optimization.
- Stage advanced from `design` to `document`.
