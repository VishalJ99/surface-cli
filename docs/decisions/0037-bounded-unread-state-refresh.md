# ADR 0037: Bounded Unread State Refresh

## Status

Accepted.

## Context

`fetch-unread` persists provider unread results, but local rows that used to be unread are not
cleared when a provider later reports them as read. A full mailbox sweep would be too expensive for
routine automation, especially for browser-backed Outlook accounts.

Callers need a bounded command that refreshes the local unread/read cache from the provider without
changing provider mailbox state.

## Decision

Add:

```sh
surface mail sync-unread-state --account <account> --limit <n> [--session <session_id>] [--rebaseline]
```

The default mode fetches provider unread up to `limit`, persists those results through the existing
`fetchUnread` path, then compares fetched unread messages against local unread message candidates
for the account. The local candidate set is newest-first and capped by the same `limit`. Surface
clears stale local unread only inside that bounded comparison set and recomputes affected thread
unread counts.

`--rebaseline` is explicit stronger behavior. Surface first clears local unread state for the
account, then fetches and persists provider unread up to `limit`. When the provider returns exactly
`limit` threads, the result reports partial/truncated because unread state outside the fetched
window may still exist at the provider but is not represented locally.

This command is a local cache refresh, not a mailbox mutation. It does not require the write-action
allowlist used by `mark-read`, `mark-unread`, or `read --mark-read`.

## Consequences

- Routine agents can repair stale unread cache state without an all-history sweep.
- Default behavior is bounded and may leave older stale unread rows untouched until a larger limit
  or explicit rebaseline is used.
- Rebaseline can intentionally drop local unread rows outside the provider result window, so it must
  report partial/truncated when the provider returns the requested limit.
- Providers do not need a new adapter method; the command reuses `fetchUnread` and SQLite state
  helpers.
