# ADR 0047: Reuse Warm Outlook Sessions For Default Live Reads

## Status

Accepted (PER-569; supersedes the opt-in default in ADR 0032)

## Context

Repeated Outlook reads otherwise pay browser startup on every command. The existing daemon and
session registry already provide account binding, expiry, serialized requests and explicit lifecycle
commands. A 20-second caller readiness limit can expire before browser/auth bootstrap completes.

## Decision

For `outlook-web-playwright`, provider-backed `search`, `fetch-unread`, `sent`, `sync-unread-state`,
thread refresh and live `read` obtain an unexpired healthy warm session automatically when
`--session` is absent. Select the newest compatible running or starting session; concurrent first
reads share its startup through a short immediate SQLite selection/reservation transaction.

Cache-only thread/read results keep their current cache predicates and do not start a browser.
`read --mark-read` and other writes retain stateless behavior. Other transports retain their current
behavior. When a session is used, an explicit session ID remains authoritative, with no replacement or fallback
on failure. Cached `thread get` continues to ignore `--session` until a live refresh is needed.
`session start` always creates an independent session, and `list`/`stop` remain available.

Defaults remain one hour idle and seven days maximum age. Expired, dead or unreachable automatic
candidates can be replaced before a provider operation. Provider RPC errors are returned without
retry. Readiness checks the socket connection and is bounded by 60 seconds of browser/bootstrap allowance
plus twice `provider_timeout_ms` (navigation and mailbox readiness): 120 seconds at the default
30-second provider timeout. Startup failures terminate the daemon process group created by that
caller and record failure. Callers joining an existing startup do not terminate its process.

## Consequences

Read-heavy workflows reuse the existing serialized daemon without tracking a session ID. Daemons
remain observable and stop automatically at expiry or through `session stop`. Startup may take
longer than 20 seconds but cannot wait indefinitely. Mail JSON schemas, refs, cache semantics,
summarization configuration and SQLite schema remain unchanged.

Automatic reuse requires a private SHA-256 fingerprint of effective runtime config and inherited
summarizer credentials/agent environment. A bounded five-second ping responds independently of
serialized browser operations and the new daemon protocol does not renew TTL. Legacy or incompatible daemons remain
available to explicit users but are skipped for automatic reuse; no raw credentials or new public
fields are exposed. This preserves the caller's selected summarizer settings without changing them.
