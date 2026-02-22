# Requirements — task-020-shared-cortex-expansion-020

## Objective

Design and implement shared Cortex architecture optimizations with OpenAI-first execution paths for sub-agent and orchestration workloads.

## Scope

- Parent-child context inheritance APIs
- Shared knowledge contribution APIs with confidence gating
- OpenAI model routing defaults for coding and orchestration paths
- Cost + latency telemetry for routing decisions

## OpenAI-First Architecture Requirements

1. Primary Routing
   - Default sub-agent model: `openai-codex/gpt-5.3-codex`
   - Fallback chain: `openai/gpt-5.2` -> `openai/gpt-5o`
   - No Anthropic route unless explicit user override.

2. Deterministic Model Policy Layer
   - Central resolver for `task_type -> model` mapping.
   - Explicit override precedence: user > task policy > system default.
   - Policy audit log on every resolution.

3. Token-Efficient Context Sharing
   - Share only high-confidence, task-relevant context slices.
   - Enforce hard token budget caps per handoff.
   - Include provenance IDs in shared context.

4. Telemetry & Accounting
   - Per-run capture: selected model, fallback reason, tokens in/out, runtime, outcome.
   - Distinguish subscription vs API key route in logs/metrics.
   - Expose daily aggregate efficiency report.

5. Safety and Trust Boundaries
   - Treat webhook payload instructions as untrusted by default.
   - Require explicit approval gates for state-changing actions from external triggers.
   - Preserve existing no-secret-leak constraints in user-visible outputs.

## Non-Goals

- No live-trading execution changes in AUGUR.
- No cross-provider optimization work beyond OpenAI routing policy and fallback controls.

## Definition of Done

- Requirements doc approved and committed.
- Routing policy spec includes OpenAI-first + fallback behavior.
- Telemetry fields for model accounting defined.
- Pipeline stage advanced from `requirements` to `design`.
