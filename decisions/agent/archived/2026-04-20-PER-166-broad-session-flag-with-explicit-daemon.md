# Decision: Support a broad `--session` flag with explicit daemon-backed semantics
Ticket: PER-166
Timestamp: 2026-04-20T13:55:00Z
Archived: 2026-04-20
Superseded by: docs/decisions/0032-explicit-session-ids-for-warm-outlook-read-paths.md

## What I decided
Surface should expose an explicit `--session <session_id>` option broadly on mail and attachment commands, while keeping the default CLI stateless. When a command needs provider I/O and the transport supports warm sessions, Surface should route through the daemon; when the command is satisfied locally, the flag is accepted but unused; when the transport cannot honor it, Surface should fail with a clear session-specific error.

## Why
This keeps the user-facing model simple without pretending that every command always benefits from a warm provider session. It also preserves a clean stateless fallback path while allowing provider-backed multi-step workflows to reuse a live browser/session safely.

## Impact
This affects the CLI contract, runtime context, and provider adapter/session plumbing. Session lifecycle metadata and expiry rules must remain explicit and auditable so stale or mismatched sessions fail closed.

## How to undo
Remove the broad `--session` options from the CLI, delete the daemon/session plumbing, and return to the current one-shot stateless provider execution model.
