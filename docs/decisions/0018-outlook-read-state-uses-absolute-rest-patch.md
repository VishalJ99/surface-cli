# ADR 0018: Outlook Read-State Mutations Use Absolute REST PATCH Calls

## Status

Accepted

## Context

The first design discussion assumed Outlook read and unread state might need to be changed through
the OWA message-list toolbar. That UI path is awkward:

- the toolbar action can behave like a context-sensitive toggle
- mixed read and unread selections are ambiguous
- UI selectors are more brittle than the provider-backed read path already in Surface

During implementation we verified that the same OWA-authenticated bearer session used by Surface
can PATCH Outlook message state directly through the Outlook REST API and receive an absolute
`IsRead` result in the response body.

## Decision

Outlook read-state commands will not use the OWA toolbar as their primary transport.

Instead:

- `surface mail mark-read <message_ref>...`
- `surface mail mark-unread <message_ref>...`
- `surface mail read <message_ref> --mark-read`

all use the OWA-authenticated REST message endpoint and PATCH `IsRead` to the requested absolute
state for each resolved message id.

This changes the earlier tentative assumption that bulk operations needed a shared local unread
state pre-check to avoid the toolbar toggle semantics. Because the transport is now absolute
instead of toggle-based:

- mixed-state batches are acceptable
- already-correct messages are effectively idempotent
- verification is based on the provider response body, not DOM style changes

Surface still updates SQLite only after the provider call succeeds and returns the expected state.

## Consequences

- mark-read and mark-unread are simpler and more reliable than a UI fallback
- `read --mark-read` can stay a small convenience wrapper over the same provider-backed mutation
- the Outlook implementation no longer depends on selection state in the message list UI
- if Outlook removes or changes REST PATCH support for OWA-issued tokens, any new fallback path
  must be documented explicitly rather than silently reintroducing toolbar-toggle behavior
