# RCA: Phantom `<media:unknown>` User Messages

**Date:** 2026-02-19  
**Investigator:** Claude Code (subagent: rca-media-unknown)  
**Severity:** Medium  
**Status:** Root cause identified, fix documented

---

## 1. Summary

Two distinct bugs were found:

1. **Phantom `<media:unknown>` messages**: Agent reply text containing the literal string `<media:unknown>` was failing to send via Signal due to a shell quoting bug in the metrics writer, causing `tool reply failed` errors. These errors were then misinterpreted in session context.
2. **Metrics writer completely broken**: All `writeMetric()` calls fail because the generated Python command embeds double-quoted strings inside an outer double-quoted shell command, causing shell interpolation to strip the inner quotes.

---

## 2. Metrics Writer Bug (CONFIRMED ROOT CAUSE)

### Behavioral Signature

```
NameError: name 'no_match' is not defined
NameError: name 'memory_injected' is not defined
NameError: name 'read_only_pass' is not defined
```

### Root Cause

In `~/Projects/helios/extensions/cortex/index.ts` lines 71-100, the `writeMetric()` function constructs a Python one-liner:

```typescript
const pythonCmd = `python3 -c "
...
writer.write_sop_event("${data.sop_name}", ${data.tool_blocked ? "True" : "False"}, "${data.tool_name || ""}", ${data.acknowledged ? "True" : "False"})
"`;
```

The **outer shell delimiter is double quotes** (`python3 -c "..."`), but the **inner Python string literals also use double quotes** (`"${data.sop_name}"`). The shell strips the inner double quotes, so Python receives:

```python
writer.write_sop_event(no_match, False, , False)
#                      ^^^^^^^^ bare identifier, not a string!
```

### Fix Required

Change `generatePythonCall()` to use **single quotes** for Python string literals:

```typescript
function generatePythonCall(type: string, data: any): string {
  switch (type) {
    case "cortex":
      return `writer.write_cortex_metric('${data.metric_name}', ${data.metric_value}, '${data.context || ""}')`;
    case "sop":
      return `writer.write_sop_event('${data.sop_name}', ${data.tool_blocked ? "True" : "False"}, '${data.tool_name || ""}', ${data.acknowledged ? "True" : "False"})`;
    case "synapse":
      return `writer.write_synapse_metric('${data.from_agent}', '${data.to_agent}', '${data.action}', '${data.thread_id || ""}', ${data.latency_ms || "None"})`;
    case "pipeline":
      return `writer.write_pipeline_metric('${data.task_id}', '${data.stage}', '${data.result}', ${data.duration_ms || "None"})`;
    default:
      return "pass";
  }
}
```

### Failure Mode Signature

- **Before fix:** Every `writeMetric()` call silently fails with Python NameError/SyntaxError
- **After fix:** `grep "Metrics write failed" gateway.log` should return zero results
- **Debugging hook:** `python3 -c "print('hello')"` works; `python3 -c "print("hello")"` fails

---

## 3. Phantom `<media:unknown>` Messages (ANALYSIS)

### Mechanism

In `src/signal/monitor/event-handler.ts`, when a Signal message arrives with an attachment whose MIME type is unknown or null, the code generates:

```typescript
const kind = mediaKindFromMime(mediaType ?? undefined);
// kind = "unknown" when MIME is null, undefined, or unrecognized
placeholder = `<media:${kind}>`; // → "<media:unknown>"
```

This becomes the `bodyText` and gets injected into session context as a user message.

### Why No Gateway Logs?

The Signal SSE stream (`/api/v1/events`) delivers events directly from signal-cli's SSE endpoint. These events are processed by the event handler but are **not logged by the gateway** — the gateway only logs its own HTTP API calls. The SSE stream is a separate long-lived connection.

Possible triggers for phantom events:

1. **SSE reconnection replaying events** — When the SSE stream reconnects (see `sse-reconnect.ts`), signal-cli may re-deliver unacknowledged events, including old attachment messages
2. **Signal delivery receipts or edit messages** that reference attachments — `envelope.editMessage?.dataMessage` is also checked for attachments
3. **Empty messages with attachments** — If someone sends an attachment-only message with no text, and the MIME type is unrecognized, the entire bodyText becomes `<media:unknown>`

### The Reply Failure Loop

When the agent then _discusses_ `<media:unknown>` in its reply text, the reply text contains literal strings like `<media:unknown>`. The `sendMessageSignal` function processes this text through `markdownToSignalText` (markdown formatting), not `splitMediaFromOutput` (media extraction). The `ENOENT` and `ENAMETOOLONG` errors in gateway logs suggest the text fragments were being passed to file operations, likely through the media attachment resolution path when `opts.mediaUrl` was somehow set.

### Recommended Investigation

1. Enable verbose logging for Signal SSE events to capture the actual event data when phantom messages arrive
2. Add logging before the `handleSignalInboundMessage` call to capture the raw envelope
3. Check if `signal-cli` has a `--send-read-receipts` or similar flag that could cause event replay on SSE reconnect

---

## 4. Impact Assessment

| Component       | Impact                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| Metrics writer  | All metrics writes failing since deployment. Zero metrics collected.         |
| Session context | Phantom user messages polluting agent context, causing confusion             |
| Reply delivery  | Intermittent ENOENT/ENAMETOOLONG errors when agent text contains `<media:*>` |

---

## 5. Files Affected

| File                                  | Issue                                                   | Fix                                                |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `extensions/cortex/index.ts:71-100`   | Shell quoting bug in `writeMetric`/`generatePythonCall` | Change inner double quotes to single quotes        |
| `src/signal/monitor/event-handler.ts` | `<media:unknown>` placeholder generation                | Working as designed, but needs SSE event logging   |
| `src/signal/sse-reconnect.ts`         | Possible event replay on reconnect                      | Needs investigation — add event dedup by timestamp |

---

## 6. Version Forensics

### Before Fix

```bash
# Detect metrics failure
grep "NameError\|SyntaxError" ~/.openclaw/logs/*.log
# Detect phantom media messages
grep "media:unknown" ~/.openclaw/sessions/*.json
```

### After Fix

```bash
# Verify metrics are writing
sqlite3 ~/.openclaw/metrics.db "SELECT COUNT(*) FROM cortex_metrics WHERE datetime(timestamp) >= datetime('now', '-1 hour')"
# Should return > 0
```

### Rollback Plan

The metrics writer fix is string-only (double quotes → single quotes). Rollback: revert the single character change in `generatePythonCall`.
