# ADR 0001: Thread-First Result Model

## Status

Accepted

## Context

Search-like mail operations naturally return grouped conversation state. Later commands
such as reply, archive, or thread review also benefit from a thread-oriented model.

## Decision

Surface CLI result sets are thread-first.

- threads are the top-level unit in `search` and `fetch-unread`
- messages are elements within each thread
- commands that act on one email should still accept `message_ref`

## Consequences

- thread and message refs are both required
- result JSON must represent both levels clearly
- later action commands can choose thread-level or message-level targets
