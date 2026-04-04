# ADR 0022: Gmail Thread Read Path Uses `threads.list` And `threads.get`

## Status

Accepted

## Context

Surface's public search contract is thread-first:

- `search` returns `threads[]`
- `fetch-unread` returns `threads[]`
- later actions still resolve stable `message_ref` values inside those threads

For Gmail, the API can be approached either through message-first list/get calls or by listing
threads and hydrating them into full conversations.

## Decision

Gmail `search` and `fetch-unread` should use:

- `users.threads.list` to find candidate Gmail thread ids
- `users.threads.get` with `format=full` to hydrate each thread into structured messages

Surface then normalizes those Gmail thread payloads into the shared thread-first schema and
persists the resulting thread/message state into SQLite.

## Consequences

- Gmail fits the same top-level result shape as Outlook without special-casing the public CLI
- normalization can assign stable `thread_ref` and `message_ref` values from hydrated Gmail data
- later `read` and attachment operations can resolve through stored provider locators instead of
  depending on the original search output
- broad Gmail queries may require more hydration work up front because each returned thread is
  fetched in full rather than streamed as lightweight message stubs
