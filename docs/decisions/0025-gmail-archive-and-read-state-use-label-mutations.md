# ADR 0025: Gmail Archive And Read State Use Absolute Label Mutations

## Status

Accepted

## Context

Surface exposes provider-neutral mailbox state actions:

- `archive <message_ref>`
- `mark-read <message_ref>...`
- `mark-unread <message_ref>...`
- `read <message_ref> --mark-read`

Gmail models these actions through labels rather than UI toggles.

## Decision

Surface should implement Gmail mailbox-state mutations through the Gmail API:

- archive removes the `INBOX` label from the containing Gmail thread
- mark-read removes the `UNREAD` label from each target Gmail message
- mark-unread adds the `UNREAD` label to each target Gmail message

After mutation, Surface refreshes the affected Gmail thread(s) and updates SQLite from the live
provider state.

## Consequences

- Gmail mailbox-state actions are absolute and deterministic rather than UI-toggle-based
- mixed-state multi-message mark operations are safe because Gmail label mutation is explicit
- archive is thread-oriented in Gmail even though the CLI entrypoint accepts a `message_ref`
- local unread counts and mailbox labels stay synchronized by refetching after mutation
