# ADR 0032: Use Explicit Session IDs For Warm Outlook Read Paths

## Status

Accepted

## Context

Surface is stateless by default, but Outlook browser startup is a repeated cost for agents that
need to do several live operations in sequence. Typical examples are:

- search, then inspect a specific thread
- fetch unread, then refresh/read several messages from the same mailbox
- watch-oriented workflows that poll and then drill into one changed conversation

Surface needs an opt-in way to reuse an already-open Outlook browser session without changing the
 default one-shot CLI behavior.

## Decision

Add an explicit session model:

- `surface session start --account <account>`
- `surface session list`
- `surface session stop <session_id>`

Session ids are opaque refs of the form `sess_<ulid>`.

Behavior rules:

- sessions are opt-in; the default stateless CLI behavior remains unchanged
- v1 warm sessions are supported only for `outlook-web-playwright`
- v1 session-aware commands are:
  - `surface mail search --session <session_id>`
  - `surface mail fetch-unread --session <session_id>`
  - `surface mail thread get <thread_ref> --refresh --session <session_id>`
  - `surface mail read <message_ref> [--refresh] --session <session_id>`
- read-path sessions remain read-only in v1; write actions stay on the stateless path
- each session is bound to one account/provider/transport and must fail closed on mismatch
- a detached local daemon owns the Playwright browser and serves serialized local RPC requests
- sessions expire automatically on idle timeout and max age

Default expiry:

- idle timeout: 1 hour
- max age: 7 days

## Consequences

- agents can explicitly trade complexity for lower repeated Outlook browser startup cost
- the first live command in a session still pays mailbox and service-session capture work
- follow-on read-path commands can reuse the already-open browser and are faster in multi-step flows
- session lifecycle becomes observable in SQLite and the public CLI
- write-path daemon support is intentionally deferred until the session model proves stable
