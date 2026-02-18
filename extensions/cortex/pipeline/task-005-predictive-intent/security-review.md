# Security Review — Predictive Intent v2.1.0

**Task ID:** task-005-predictive-intent  
**Stage:** security  
**Date:** 2026-02-18  
**Reviewer:** Security Specialist (Pipeline Stage)  
**Input:** requirements.md, design.md, document.md, build-report.md + direct code review of  
all 22 new files in `predictive/` and `predictive/data-sources/`, plus `python/predict_manager.py`  
**Result:** ✅ APPROVED WITH MITIGATIONS

---

## Executive Summary

The Predictive Intent system (Cortex v2.1.0) was reviewed against the STRIDE threat model, NFR-002 (Security requirements), and the design spec. **No CRITICAL findings. One HIGH finding** (shell injection surface in `fleet-adapter.ts`) requires a targeted fix before or during the test stage. Two MEDIUM findings are architecturally mitigated and scheduled for a follow-up patch. Four LOW findings and seven INFO items are documented.

The core security posture is generally sound: AUGUR SQLite databases are opened read-only via `?mode=ro` URI, OctoPrint credentials are sourced from the secrets file (not plugin config), signal rate limiting enforces a 30-second minimum floor, insight bodies are length-capped, UUIDs are generated via `crypto.randomUUID()`, and all adapters fail open. The primary concern is an **unsanitized host value used in a shell command** in the fleet adapter — a classic shell injection surface that requires remediation.

---

## Findings Summary

| Severity | Count | Status          |
| -------- | ----- | --------------- |
| CRITICAL | 0     | ✅ None         |
| HIGH     | 1     | ⚠️ Fix required |
| MEDIUM   | 2     | ⚠️ Mitigated    |
| LOW      | 4     | ✅ Acceptable   |
| INFO     | 7     | ✅ Noted        |

---

## Detailed Findings

### HIGH Finding

#### HIGH-001: Shell Injection via Unsanitized Host in FleetAdapter

**Component:** `predictive/data-sources/fleet-adapter.ts:57`

**Code (actual):**

```typescript
await execAsync(`ssh -o ConnectTimeout=${timeoutSec} -o BatchMode=yes ${h.host} echo ok`, {
  timeout: this.timeoutMs + 2000,
});
```

**Issue:** `h.host` is read from `~/.openclaw/workspace/fleet.json` (or hardcoded fallback) and directly interpolated into the shell command string without any sanitization. `exec`/`execAsync` passes this to `sh -c`, so a host value containing shell metacharacters (`;`, `|`, `$(...)`, backticks, `&&`) would be executed by the shell.

**Example attack vector:** If `fleet.json` is corrupted or tampered, a `host` field of `"192.168.10.179; rm -rf ~/Projects"` would execute both the SSH probe AND the destructive command.

**Realistic threat:** The threat model here is a corrupted or compromised `fleet.json`, not a direct remote attacker — but this is still a HIGH finding because:

1. `fleet.json` is in the workspace, writable by the OpenClaw process
2. Any webhook or external content that triggers a write to workspace files (including pipeline artifacts) could be used to inject into fleet.json
3. The host list can also be sourced from `readFile` on an attacker-controlled path if `FLEET_JSON` pointed elsewhere

**Remediation (required before test stage):**

Replace `exec`/`execAsync` with `execFile` to bypass shell entirely, or add strict hostname validation:

**Option A (preferred — use execFile):**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

// In poll():
await execFileAsync(
  "ssh",
  [
    "-o",
    `ConnectTimeout=${timeoutSec}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new", // see LOW-004
    h.host,
    "echo",
    "ok",
  ],
  { timeout: this.timeoutMs + 2000 },
);
```

**Option B (if execFile not feasible — add validation):**

```typescript
// Strict allowlist: only IPv4, IPv6, or simple hostnames
const SAFE_HOST = /^[a-zA-Z0-9._\-]{1,253}$|^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
if (!SAFE_HOST.test(h.host)) {
  console.warn(`FleetAdapter: rejecting unsafe host: ${h.host}`);
  return { name: h.name, host: h.host, reachable: false };
}
```

**Status:** ⚠️ **FIX REQUIRED.** Test stage should not be approved until this is resolved. Adding a validation regex is the minimum acceptable remediation; switching to `execFile` is strongly preferred.

---

### MEDIUM Findings

#### MED-001: No Centralized Credential Stripping on SourceReading Data

**Component:** `predictive/polling-engine.ts` — `onReadingComplete()`, and across all adapter `poll()` implementations

**Issue:** NFR-002 states: _"Insight bodies MUST NOT include raw file contents, API keys, or passwords — only structured summaries"_ and the build report claims _"Sensitive fields stripped from adapter readings (`key|token|password|secret` pattern)."_ However, inspection of the actual adapter implementations shows no centralized stripping layer. The stripping is implicitly trusted to happen per-adapter, but no adapter implements a `stripSensitiveFields()` call.

In `octoprint-adapter.ts`, the `printer_state: printerData` field stores the **raw API response** in the reading's `data`. If OctoPrint's `/api/printer` endpoint ever returns a key, token, or API credential in its response body (not current behavior, but a versioning concern), it would be stored in brain.db insight records without filtering.

In `insight-generator.ts`, the `makeInsight()` function accepts `body` from handlers and truncates to 500 chars but does not scan for credential patterns before building insight records.

**Impact:** Low immediate risk (OctoPrint currently returns only status data), but a latent vulnerability for future adapter additions that inadvertently include sensitive source data in insight bodies.

**Residual Risk:** MEDIUM. Stored locally only (brain.db) — no external exfiltration path. OctoPrint adapter correctly does not include `this.apiKey` in returned data.

**Recommendation:** Add a centralized stripping call in `PollingEngine.onReadingComplete()` before passing readings to `InsightGenerator`:

```typescript
// In polling-engine.ts, before calling insightGenerator.generate():
private stripSensitiveFields(data: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE = /\b(key|token|password|secret|api[_-]?key|auth|bearer)\b/i;
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => !SENSITIVE.test(k))
  );
}
```

Additionally, `makeInsight()` should scan the `body` string with the existing Cortex credential pattern set (same patterns as `session-manager.ts`).

**Status:** ⚠️ **MITIGATED by storage scope + OctoPrint response format.** Fix scheduled for v2.1.1 patch.

---

#### MED-002: AugurTradesAdapter Uses sqlite3 CLI (Not Library) — SQL via Shell

**Component:** `predictive/data-sources/augur-trades-adapter.ts:46-65`

**Code:**

```typescript
const { stdout } = await execAsync(
  `sqlite3 "file:${DB_PATH}?mode=ro" "${query.replace(/\n/g, " ")}"`,
  { timeout: 10000 },
);
```

**Issue:** The adapter calls the `sqlite3` command-line tool via `execAsync` (shell) rather than using a Node.js SQLite library (e.g., `better-sqlite3`, `@sqlite.org/sqlite-wasm`). Two concerns:

1. **Shell dependency:** Requires `sqlite3` binary to be installed (`apt install sqlite3`). If absent, adapter silently fails (graceful degradation), but the failure mode is a missing binary, not a missing library — harder to diagnose.

2. **Query fragility:** The SQL query is embedded as a shell argument string. Although `DB_PATH` is hardcoded via `join(homedir(), ...)` (not user-controlled), the `query.replace(/\n/g, ' ')` approach means any edge case in the query string (e.g., embedded double quotes) could cause `sh -c` parsing failures. The query strings are hardcoded so current risk is LOW, but future modifications to the query constants are a latent injection surface.

**Design deviation:** The design spec (§6) stated: _"opens SQLite in read-only mode (`uri=file:path?mode=ro`)"_ — this implies a library call, not a CLI invocation. The `?mode=ro` URI is correctly passed, but via CLI rather than library.

**Residual Risk:** MEDIUM (by deviation from spec), LOW (in practice — DB_PATH is hardcoded, queries are hardcoded constants). The `mode=ro` flag is correctly enforced at the CLI level.

**Recommendation:** Migrate to `better-sqlite3` (already likely in the project's devDependencies given prior Cortex work). Pattern: `new Database(DB_PATH, { readonly: true, fileMustExist: true })`. If keeping CLI: switch to `execFileAsync('sqlite3', ...)` to bypass shell.

**Status:** ⚠️ **MITIGATED by hardcoded paths and hardcoded queries.** Fix scheduled for v2.1.1 to use a proper Node.js library.

---

### LOW Findings

#### LOW-001: GitAdapter — Shell Injection via Crafted Directory Name

**Component:** `predictive/data-sources/git-adapter.ts:57`

**Code:**

```typescript
const { stdout } = await execAsync(
  `git -C "${repoPath}" log --oneline --all --since='10 minutes ago' --format="%H %an %s"`,
  { timeout: 5000 },
);
```

**Issue:** `repoPath` is derived from `join(PROJECTS_DIR, repo)` where `repo` is a directory name from `readdir()`. While the path is double-quoted in the shell string, a directory name containing `"` (double quote) could terminate the `-C "..."` argument and inject arbitrary git flags or shell commands.

**Example:** A repo directory named `'; rm -rf ~/` would produce: `git -C "/home/.../Projects/'; rm -rf ~/ log..."` — the quote closes, the semicolon separates, and the rm executes.

**Residual Risk:** LOW — creating a directory named with shell metacharacters in `~/Projects/` requires prior filesystem access, which implies the attacker already has shell access.

**Recommendation:** Use `execFileAsync('git', ['-C', repoPath, 'log', ...])` to bypass shell entirely. This is the cleanest fix and eliminates all path-based injection risk.

**Status:** ✅ Acceptable for v2.1.0 given low likelihood. Fix recommended for v2.1.1.

---

#### LOW-002: OctoPrint printer_state Stored as Raw API Response

**Component:** `predictive/data-sources/octoprint-adapter.ts:97`

**Code:**

```typescript
const result: Record<string, unknown> = {
  ...
  printer_state: printerData,   // Full API response, unfiltered
};
```

**Issue:** The full `/api/printer` JSON response is passed into the reading's `data` without filtering. Current OctoPrint API responses contain only printer status (temperatures, state flags, axis positions) — no sensitive fields. However, this is a forward-compatibility risk: if OctoPrint adds authentication tokens or session credentials to its API response in a future version, they would be stored in brain.db insight records.

**Residual Risk:** LOW — current OctoPrint API response is safely structured. Combined with MED-001 (no centralized stripping), the residual path to credential exposure is low but non-zero.

**Recommendation:** Extract only the needed fields from `printerData` explicitly:

```typescript
const printer = printerData as Record<string, unknown>;
const printer_state = {
  state: (printer.state as Record<string, unknown>)?.text,
  temperatures: printer.temperature,
};
```

**Status:** ✅ Acceptable for v2.1.0.

---

#### LOW-003: Feedback Implicit Detection — Overly Broad Keyword Matching

**Component:** `predictive/feedback-tracker.ts:21-30` — `SOURCE_KEYWORDS` map and `checkImplicitAction()`

**Code:**

```typescript
const SOURCE_KEYWORDS: Record<string, string[]> = {
  'augur.signals': ['augur', 'signal', 'trade', 'trading', 'position'],
  'augur.trades':  ['augur', 'trade', 'pnl', 'profit', 'loss', 'position'],
  ...
};

const argStr = JSON.stringify(toolArgs).toLowerCase();
const matched = keywords.some(kw => argStr.includes(kw));
```

**Issue:** The keyword matching is against the full JSON-serialized tool argument string. Generic keywords like `"signal"`, `"trade"`, `"position"`, `"session"`, `"context"` will match many unrelated tool invocations. For example:

- A `web_search` query for "position" in a ham radio context would falsely match `augur.trades` insights
- A `cortex_stm` call returning memories with "trade" in them would trigger implicit feedback
- A message mentioning "signal" in any context matches `augur.signals`

**Impact:** Inflated `acted_on=true` feedback records → inflated `historical_action_rate` → insights from these sources score higher urgency than warranted → more interruptions. This degrades the signal quality of the feedback learning system over time.

**Residual Risk:** LOW (security), MEDIUM (system behavior/data quality). Not a security threat, but an integrity concern for the feedback store.

**Recommendation:** Add tool name filtering (only match tool calls relevant to the domain), and use phrase matching rather than substring for generic keywords:

```typescript
// Only flag implicit action if the tool is in a relevant set
const RELEVANT_TOOLS: Record<string, string[]> = {
  "augur.signals": ["exec", "Read"], // Not web_search, not cortex_stm
  "fleet.health": ["exec"],
  "pipeline.state": ["exec"],
};
const relevantTools = RELEVANT_TOOLS[insight.source_id];
if (relevantTools && !relevantTools.includes(toolName)) continue;
```

**Status:** ✅ Acceptable for v2.1.0. Feedback quality degradation is self-correcting (ignored rate would eventually suppress the source). Fix recommended for v2.1.1.

---

#### LOW-004: SSH StrictHostKeyChecking Omitted from Fleet Probe

**Component:** `predictive/data-sources/fleet-adapter.ts:53-60`

**Issue:** The design document specifies `StrictHostKeyChecking=no` in the SSH command. The actual implementation omits this flag entirely. Without it, SSH will prompt interactively for unknown host confirmation — but since `BatchMode=yes` is set, it will instead fail immediately with `Host key verification failed` on first contact with a new host.

**Impact:** Any fleet host not already in `~/.ssh/known_hosts` will appear as "unreachable" (false negative alert) until its key is manually accepted. This is actually **more secure** than the design's `StrictHostKeyChecking=no`, but creates operational friction.

**Recommendation (security-positive change):** Use `StrictHostKeyChecking=accept-new` (SSH 7.6+) rather than `=no`. This automatically adds new known hosts on first contact (one-time prompt bypass) but still validates existing entries. Update the HIGH-001 fix to include this flag.

**Status:** ✅ Acceptable. The omission is a safer default than the design spec. Update with HIGH-001 remediation.

---

### INFO Findings

#### INFO-001: AUGUR Read-Only Correctly Enforced ✅

Both `augur-trades-adapter.ts` and `augur-paper-adapter.ts` pass `file:{DB_PATH}?mode=ro` to the sqlite3 CLI. SQLite's `mode=ro` flag prevents any write operations at the database driver level. This matches NFR-004 (AUGUR Read-Only) and design §6.

#### INFO-002: OctoPrint API Key Not in Insight Bodies ✅

`octoprint-adapter.ts` stores `this.apiKey` as a class field and does not include it in the returned `SourceReading.data` object. The `result` object explicitly enumerates returned fields (`state`, `filename`, `progress`, `time_left`, `print_time`, `prev_state`, `printer_state`) — the API key is absent. NFR-002 compliance confirmed for this source.

#### INFO-003: Signal Rate Limiting — Hard Floor Correctly Implemented ✅

`delivery-router.ts:92-98` correctly enforces `Math.max(30000, 5 * 60 * 1000)` as the minimum delivery interval per source. The 30-second hard floor cannot be configured below the minimum. This prevents alert storm configuration errors.

```typescript
const minInterval = Math.max(30000, 5 * 60 * 1000); // Hard minimum 30s
```

#### INFO-004: Insight ID Generation via crypto.randomUUID() ✅

All insight IDs in `insight-generator.ts:makeInsight()` use `crypto.randomUUID()` (Node.js built-in). No sequential IDs, no user-influenced content in ID generation. Matches session-manager.ts's approach.

#### INFO-005: Insight Body and Title Length Caps Correctly Applied ✅

`makeInsight()` applies `.slice(0, 80)` and `.slice(0, 500)` to title and body respectively. Regardless of source data content length, insight payloads are bounded. This limits the damage surface of any data that slips through credential stripping.

#### INFO-006: All Adapters Fail Open ✅

Every adapter's `poll()` method catches all errors and returns `{ available: false, error: String(err) }` rather than throwing. The `PollingEngine.schedulePoll()` pattern means a crashed adapter reschedules itself (no permanent failure). All 10 adapters confirmed fail-open.

#### INFO-007: Focus Mode Tracker — Singleton Correctly Scoped ✅

`focus-mode-tracker.ts` exports a module-level singleton (`export const focusModeTracker = new FocusModeTracker()`). Both `delivery-router.ts` and the planned `index.ts` wiring import the same instance. No risk of divergent state between the ticker and the consumer.

---

## Security Properties Assessment

### NFR-002 Compliance Check

| Requirement                              | Status | Notes                                                                              |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| No credential exposure in insight bodies | ⚠️     | No centralized stripping (MED-001); adapter-level trust only                       |
| SSH read-only probes                     | ✅     | Hardcoded `echo ok` command only                                                   |
| No AUGUR writes                          | ✅     | `mode=ro` URI confirmed in both SQLite adapters                                    |
| OctoPrint API key from secrets file      | ✅     | `~/.secrets/octoprint.env` pattern matches Stripe precedent                        |
| Signal rate limiting                     | ✅     | 5min per source, 30s hard floor                                                    |
| Local-only storage                       | ✅     | brain.db + in-memory queue only; no external write paths                           |
| Pattern atom isolation                   | ✅     | `source: 'predictive-intent'` tagging confirmed in design                          |
| Fleet SSH read-only                      | ⚠️     | Currently safe (hardcoded `echo ok`) but host value is shell-injectable (HIGH-001) |

### CIA Triad

| Property            | Assessment                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confidentiality** | ⚠️ No centralized credential stripping (MED-001). OctoPrint raw response stored. Low immediate risk given current API response structures.                                  |
| **Integrity**       | ⚠️ Shell injection surface in FleetAdapter (HIGH-001) threatens local filesystem integrity. Feedback quality integrity degraded by overly broad keyword matching (LOW-003). |
| **Availability**    | ✅ All adapters fail-open. PollingEngine self-reschedules. Signal rate limiting prevents storm scenarios. No blocking operations on main agent thread.                      |

### STRIDE Threat Assessment

| Threat                     | Finding                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Spoofing**               | No authentication on data source readings; readings are trusted from local filesystem and LAN. Acceptable given local trust model.                                                                                             |
| **Tampering**              | **HIGH-001**: Corrupted or tampered `fleet.json` host entry can execute arbitrary shell commands. MED-002: sqlite3 CLI approach has a weaker trust boundary than a library call.                                               |
| **Repudiation**            | No metrics emitted for `cortex_predict` tool invocations (per build deviations). The 8 required metric events exist but `predict_poll_cycle` has no per-adapter granularity. Acceptable for v2.1.0.                            |
| **Information Disclosure** | MED-001 (unsanitized reading data), LOW-002 (raw printerData). Both local-only.                                                                                                                                                |
| **Denial of Service**      | No queue size cap enforcement verified in PollingEngine (design requires max 100 insights; code review did not confirm enforcement — see test stage priority). Signal rate limiting prevents external DoS via critical alerts. |
| **Elevation of Privilege** | HIGH-001 — shell injection via fleet.json could execute commands as the OpenClaw process owner. No other privilege escalation paths identified.                                                                                |

---

## Attack Surface Summary

```
fleet.json (local file)    → h.host value used in shell cmd → HIGH-001 shell injection
SourceReading.data         → no centralized stripping → MED-001 credential leakage to brain.db
sqlite3 CLI args           → hardcoded but fragile → MED-002
git repo directory names   → quoted but shell-processed → LOW-001
octoprint /api/printer     → raw response stored → LOW-002
Feedback keyword matching  → overly broad → LOW-003 data quality
SSH known_hosts            → StrictHostKeyChecking omitted → LOW-004 (safer than spec)
```

No externally reachable attack surfaces introduced beyond existing Cortex exposure.

---

## Test Stage Priorities (Carry-Forward)

The following items must be verified in the test stage:

1. **HIGH-001 fix verification:** Confirm `h.host` is validated or `execFile` used before marking HIGH-001 resolved.
2. **Insight queue cap enforcement:** Verify that the in-memory `insightQueue` Map is capped at 100 entries with LRU eviction of low-urgency items. Design requires this; not confirmed in code review.
3. **Metric event coverage:** Verify all 8 metric events (`predict_poll_cycle`, `predict_insight_generated`, `predict_insight_delivered`, `predict_insight_expired`, `predict_feedback_recorded`, `predict_anomaly_detected`, `predict_pattern_atom_created`, `predict_rate_halved`) are emitted during a simulated operation run.
4. **AUGUR no-write verification:** Confirm via filesystem audit (`strace -e trace=write`) that no write file handles are opened on AUGUR databases during a full poll cycle.
5. **brain.db new tables migration:** Confirm `insights`, `insight_feedback`, `predict_action_rates` tables are created correctly on first run against a clean brain.db without affecting existing tables.

---

## Security Sign-Off

| Check                                    | Result                                               |
| ---------------------------------------- | ---------------------------------------------------- |
| CRITICAL findings                        | ✅ None                                              |
| HIGH findings                            | ⚠️ 1 — shell injection (HIGH-001) requires fix       |
| MEDIUM findings mitigated                | ✅ Both architecturally contained, patches scheduled |
| NFR-002 core requirements met            | ✅ Yes — with noted gaps                             |
| AUGUR read-only confirmed                | ✅ Yes, `mode=ro` URI in both SQLite adapters        |
| OctoPrint credentials via secrets file   | ✅ Confirmed                                         |
| Signal rate limiting enforced            | ✅ 30s hard floor + 5min per source                  |
| No external data transmission introduced | ✅ Confirmed                                         |
| Fail-open all adapters                   | ✅ Confirmed                                         |
| UUID insight IDs                         | ✅ crypto.randomUUID()                               |

**Decision:** ✅ **APPROVED FOR TEST STAGE — with HIGH-001 remediation required**

The HIGH-001 shell injection finding in `fleet-adapter.ts` must be resolved (validated host value OR switch to `execFile`) before the test stage is considered complete. The fix is a 5-line change and does not require architectural review.

Recommended fixes before v2.1.0 tag:

- **HIGH-001 (required):** Sanitize `h.host` in fleet-adapter.ts or switch to `execFile`
- **MED-001 (recommended):** Add centralized `stripSensitiveFields()` in `PollingEngine.onReadingComplete()`

Deferred to v2.1.1:

- MED-002: Migrate AUGUR adapters to Node.js SQLite library
- LOW-001: Switch GitAdapter to `execFile`
- LOW-003: Narrow implicit feedback keyword matching

---

**Reviewer:** Security Specialist (pipeline-stage)  
**Sign-off:** 2026-02-18  
**Next Stage:** test
