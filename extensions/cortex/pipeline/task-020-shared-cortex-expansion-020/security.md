# Security Review — task-020-shared-cortex-expansion-020

## Scope

Security assessment of the newly introduced Shared Cortex modules:

- `shared-cortex/model-policy-resolver.ts`
- `shared-cortex/context-bus.ts`
- `shared-cortex/contribution-gateway.ts`
- `shared-cortex/telemetry.ts`
- tests in `shared-cortex/__tests__/openai-first-routing.test.ts`

This stage focuses on **trust boundaries**, **input validation**, **injection/policy bypass risks**, and **data minimization**.

## Threat Model (high-level)

### Assets

- Parent session context (working-memory, STM slices, task artifacts)
- Contribution channel back into Cortex (persistence surface)
- Telemetry store (sensitive metadata; potential indirect leakage)

### Trust boundaries

- **External/untrusted triggers** (e.g., webhooks, inbound messages) must be treated as hostile.
- **Child agent contributions** may be partially trusted depending on provenance.

### Primary attacker goals

- Trick the system into executing state-changing actions (“delete/reset/drop…”) based on untrusted input
- Exfiltrate secrets via context packets, telemetry, or contribution evidence
- Force unsafe/expensive model routing via override strings

## Findings

### F1 — External directive injection: state-change detection is heuristic

**Where:** `shared-cortex/contribution-gateway.ts`

Current guard blocks external-untrusted contributions if the `claim` matches:
`/(delete|drop|reset|destroy|revoke|terminate)/i`

**Risk:** Medium.

- Attackers can bypass with synonyms (“purge”, “wipe”, “truncate”, “rm”, “nuke”, “disable”, “rotate keys”, etc.) or obfuscated strings.
- The current module is a _validation helper_ only; if later integrated as the sole gate, it would be insufficient.

**Recommendation:**

- Treat _all_ external-untrusted contributions as **non-actionable knowledge** by default (store as observations only), unless an explicit, trusted approval is recorded elsewhere.
- If action classification is needed, introduce a structured field like `intent: "observation" | "action_request"` and reject `action_request` from `external_untrusted` unless a separate approval token is present.
- Expand keyword list if keeping heuristic detection, but do not rely on it as the only control.

### F2 — Model override is not constrained

**Where:** `shared-cortex/model-policy-resolver.ts`

Any non-empty `userOverrideModel` is accepted and returned.

**Risk:** Low→Medium (depends on downstream integration).

- If the resolved model string is later used to select providers dynamically, an attacker-controlled string could trigger unexpected routing, cost spikes, or error paths.

**Recommendation:**

- Upstream: only allow overrides from **explicit user instruction** (not from webhook or other untrusted inputs).
- Downstream: enforce an allowlist of provider/model IDs (or require `provider:model` validation) at the invocation layer.
- Add audit logging that records the _source_ of the override (user vs. external).

### F3 — Context packet can carry secrets if candidates are not pre-scrubbed

**Where:** `shared-cortex/context-bus.ts`

The context bus filters by confidence and budget only. It does not redact secrets.

**Risk:** Medium.

- If candidate items include API keys, tokens, or private user data, the packetization step will pass them through.

**Recommendation:**

- Add a pre-filter hook for secret redaction (`redactSecrets(text)`) or require a `safe_text` field.
- Ensure provenance metadata does not include raw secret-bearing identifiers.
- Consider a denylist pattern scan (keys, bearer tokens) as a last-resort safety net.

### F4 — Telemetry is safe by default (no raw prompt), but validate numeric fields

**Where:** `shared-cortex/telemetry.ts`

No prompt or content logging is present (good). Aggregation assumes numeric inputs.

**Risk:** Low.

**Recommendation:**

- Validate/normalize telemetry on ingestion: non-negative integers for tokens/duration.
- Ensure telemetry storage access controls are consistent with “metadata can be sensitive.”

## Positive Controls Present

- **External-untrusted state-change rejection** exists (even if heuristic), which is the correct default direction.
- **Data minimization in telemetry**: no raw content is captured.
- **Token budget enforcement** in context handoff reduces accidental context bloat.

## Required Follow-ups (before wiring into runtime)

1. Define a **hard rule**: external/untrusted inputs cannot directly trigger state changes.
2. Add a **secrets redaction** pass (or safe-text requirement) before context packet construction.
3. Implement a **model allowlist** at the model invocation boundary.
4. Add provenance to model override decisions (user vs task policy vs external).

## Stage Result

- Status: **pass** (security review completed; no code changes required to complete this stage)
- Notes: Findings F1–F3 should be addressed prior to enabling these modules in live runtime paths.
