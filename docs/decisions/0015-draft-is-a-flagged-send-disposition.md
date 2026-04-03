# ADR 0015: Draft Is An Explicit `--draft` Disposition On Send-Like Commands

## Status

Accepted

## Context

Surface CLI already exposes send-like commands:

- `send`
- `reply`
- `reply-all`
- `forward`

Draft creation is the same compose flow with a different final disposition. The public
interface should stay explicit for agents and humans, and config should not silently
change a `send` command into a draft action.

## Decision

Draft behavior is exposed through a `--draft` flag on existing send-like commands:

- `surface mail send ... --draft`
- `surface mail reply <message_ref> --draft`
- `surface mail reply-all <message_ref> --draft`
- `surface mail forward <message_ref> --draft`

Config remains a safety gate, not a behavior rewrite:

- if `send_mode=allow_send`, no flag sends and `--draft` drafts
- if `send_mode=draft_only`, no-flag send-like commands should error and instruct the caller to rerun with `--draft`

## Consequences

- send-like commands keep one stable shape instead of splitting into separate draft commands
- callers can explicitly choose between `sent` and `drafted`
- provider implementations can share one compose pipeline with a final disposition switch
- config no longer implies that `send` may silently draft on one machine and send on another
