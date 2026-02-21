# Requirements — task-021-shared-cortex-expansion-021

## Objective

Advance OpenAI-first shared Cortex architecture with execution hardening and deterministic routing reliability.

## Scope

- Harden model routing policy enforcement in runtime paths
- Improve fallback determinism and observability
- Standardize Python and search tool assumptions in hooks (`python3`, `grep` fallback for missing `rg`)
- Ensure stage automation remains robust under constrained host environments

## Functional Requirements

1. Routing policy must default to `openai-codex/gpt-5.3-codex` with ordered fallbacks (`openai/gpt-5.2`, `openai/gpt-5o`).
2. Every fallback must emit machine-parseable reason codes.
3. Hook scripts must be portable across hosts lacking `python` alias and `rg`.
4. Telemetry must separate subscription vs API key routing.

## Non-Functional Requirements

- No secrets in logs/user updates.
- Backward compatible with existing pipeline task state format.
- Idempotent stage-retry behavior.

## Definition of Done

- Requirements documented.
- Stage advanced to `design`.
