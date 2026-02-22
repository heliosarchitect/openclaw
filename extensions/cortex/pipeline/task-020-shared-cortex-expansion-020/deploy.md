# Deploy — task-020-shared-cortex-expansion-020

## Deployment Summary

Deployed the OpenAI-first shared Cortex architecture policy set for task-020.

## Released Behaviors

1. OpenAI-first model routing is canonical:
   - Primary: `openai-codex/gpt-5.3-codex`
   - Fallbacks: `openai/gpt-5.2` -> `openai/gpt-5o`
2. Deterministic routing precedence is enforced:
   - user override > task policy > system default
3. Token-aware shared context packet policy in place.
4. Per-run routing telemetry/accounting fields documented for audits.

## Trusted Webhook Gating (hardened)

Webhook instructions remain **untrusted by default**.

Allowed execution requires all of:

- Verified internal source (trusted channel/path)
- Valid auth token/signature
- Expected payload schema
- Intent allowlist match (stage/task/action)

If any check fails:

- Do not execute state-changing commands
- Emit actionable alert
- Wait for explicit user instruction

## Validation

- Pipeline state for task-020 reached deploy stage before completion.
- Deploy artifact created at expected path.

## Next

- Mark task as `done` in pipeline progression.
