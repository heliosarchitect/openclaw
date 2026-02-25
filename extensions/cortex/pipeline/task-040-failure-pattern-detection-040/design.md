# task-040-failure-pattern-detection-040 — design

- Status: pass
- Date: 2026-02-22

## Design intent

Use documentation-first pattern extraction from local sources of truth:

- `retention.log` for recurring DB lock/open failures
- systemd status/journal for failed unit patterns
- QA scrub report artifacts for unresolved infrastructure issues

## Output contract

A closure matrix with:

- status bucket (`done` / `blocked` / `needs-user-decision`)
- exact evidence path/command
- safe fix applied (if any)
