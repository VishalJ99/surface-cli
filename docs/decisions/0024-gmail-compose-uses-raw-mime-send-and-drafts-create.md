# ADR 0024: Gmail Compose Uses Raw MIME Plus `messages.send` Or `drafts.create`

## Status

Accepted

## Context

Surface needs Gmail write actions that match the provider-neutral compose contract:

- `send`
- `reply`
- `reply-all`
- `forward`
- `--draft` on those same commands

Unlike Outlook web automation, Gmail already exposes first-class API endpoints for sending mail
and creating drafts.

## Decision

Surface composes Gmail outbound mail as plain-text RFC 2822 / MIME messages, base64url-encodes
that payload, and then uses:

- `users.messages.send` for live sends
- `users.drafts.create` for `--draft`

Replies and reply-all keep Gmail threading by sending on the original Gmail `threadId` and by
including `In-Reply-To` and `References` headers derived from the original message.

## Consequences

- Gmail compose stays fully API-driven and headless
- `--draft` reuses the same compose path as live send with a different final disposition
- forward creates a new thread by default rather than attaching to the original thread
- the first Gmail v1 compose path is intentionally plain-text only; richer HTML compose and
  attachment upload remain future work
