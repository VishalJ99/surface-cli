# ADR 0003: Keep `fetch-unread` As The Public Command

## Status

Accepted

## Context

`unread` describes a filter but not an action. The public CLI should read naturally at
the command line and make it obvious that mail is being fetched.

## Decision

Use `surface mail fetch-unread` as the public command name.

`surface mail search` and `surface mail fetch-unread` should share the same result schema.

## Consequences

- docs, tests, and provider contracts should use `fetch-unread`
- `unread` should not become a competing top-level public command
