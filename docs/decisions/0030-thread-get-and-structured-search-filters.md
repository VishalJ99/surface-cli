# ADR 0030: Add Thread-Level Reads And Structured Search Filters

## Status

Accepted

## Context

Surface already exposes stable `thread_ref` values in `search` and `fetch-unread`, but callers
cannot retrieve or refresh a thread directly by that ref. Search is also limited to one raw
`--text` query string, which forces automation to encode sender, subject, mailbox, and label
intent into provider-specific free text.

## Decision

Surface adds:

- `surface mail thread get <thread_ref> [--refresh]`
- structured `surface mail search` criteria:
  - `--text`
  - `--from`
  - `--subject`
  - `--mailbox`
  - `--label` (repeatable)

`thread get` returns the same thread shape used inside `search` and `fetch-unread`, wrapped in a
thread-specific envelope with cache status. Providers expose a thread-refresh hook keyed by the
stable local `thread_ref`, while SQLite remains the local source of truth for reconstructing the
public thread object.

## Consequences

- automation can watch and refresh a specific conversation without re-running a fuzzy search
- `thread_ref` becomes a first-class read target alongside `message_ref`
- search remains provider-backed, but structured criteria can compile into provider-native query
  syntax where available and fall back to normalized result filtering where needed
