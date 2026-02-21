# Build Report — task-021-shared-cortex-expansion-021

## Summary

Implemented the build-stage hardening for shared Cortex OpenAI-first routing:

1. Added a central runtime routing boundary (`shared-cortex/model-router.ts`) to enforce deterministic model selection/fallback behavior.
2. Added deterministic failure classification into required reason codes (`timeout`, `provider_5xx`, `capacity`, `policy_override`).
3. Added machine-parseable fallback JSONL formatter (`buildFallbackJsonlLine`) for transition telemetry.
4. Extended telemetry schema with non-secret diagnostics (`error_class`, `attempt_count`) while preserving route type tracking (`subscription` vs `api_key`).
5. Added/expanded tests to validate routing defaults, fallback determinism, route-type defaulting, and parseable JSON fallback records.

## Files Changed

- `shared-cortex/model-router.ts` (new)
- `shared-cortex/telemetry.ts`
- `shared-cortex/__tests__/openai-first-routing.test.ts`

## Build Validation

Executed from repo root (`~/Projects/helios`):

```bash
pnpm vitest run extensions/cortex/shared-cortex/__tests__/openai-first-routing.test.ts
pnpm tsc --noEmit
```

### Results

- Vitest: **pass** (10/10 tests)
- TypeScript compile gate (`tsc --noEmit`): **pass**

## Behavioral Notes

- Router defaults `route_type` to `api_key` when absent and appends `route_type_defaulted` policy audit marker.
- Fallbacks are deterministic and preserve configured chain order:
  - `openai-codex/gpt-5.3-codex`
  - `openai/gpt-5.2`
  - `openai/gpt-5o`
- Telemetry remains non-secret; only classified diagnostics are emitted.

## Stage Outcome

- Stage: `build`
- Result: `pass`
- Next stage: `security`
